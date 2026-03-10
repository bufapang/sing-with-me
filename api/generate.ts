import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// OSS配置
const OSS_REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';
const OSS_BUCKET = process.env.OSS_BUCKET || 'sing-with-me-shu';
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';

// 音乐分离
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// RVC推理
const RVC_INFER_VERSION = '0a9c7c558af4c0f20667c1bd1260ce32a2879944a0b9e44e1398660c077b1550';

// RVC训练
const RVC_TRAIN_VERSION = 'cf360587a27f67500c30fc31de1e0f0f9aa26dcd7b866e6ac937a07bd104bad9';

async function createPrediction(version: string, input: any): Promise<string> {
  console.log('Creating prediction:', version);
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version, input }),
  });
  
  const data = await res.json();
  if (!res.ok) {
    console.error('Error:', data);
    throw new Error(data.detail || 'Failed');
  }
  return data.id;
}

async function checkPrediction(id: string) {
  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
  });
  const data = await res.json();
  return { status: data.status, output: data.output, error: data.error };
}

async function proxyAudio(url: string, res: VercelResponse) {
  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = url.split('.').pop()?.toLowerCase();
    const contentType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to proxy' });
  }
}

async function uploadToOSS(base64Data: string, filename: string): Promise<string> {
  console.log('Uploading to OSS:', filename);
  
  // 动态导入 ali-oss
  const AliOSS = await import('ali-oss');
  const client = new AliOSS.default({
    region: OSS_REGION,
    bucket: OSS_BUCKET,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
  });
  
  const buffer = Buffer.from(base64Data, 'base64');
  const result = await client.put(`voices/${filename}`, buffer);
  console.log('OSS upload result:', result.url);
  return result.url;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  let body = request.body;
  if (request.method === 'POST' && typeof request.body === 'string') {
    try { body = JSON.parse(request.body); } catch { body = {}; }
  }
  
  const { songUrl, userVoiceUrl, step, predictionId, proxy, url } = body || request.query || {};

  if (request.method === 'GET' && proxy === 'true' && url) {
    await proxyAudio(url as string, response);
    return;
  }

  if (request.method === 'GET' && predictionId) {
    if (predictionId === 'preset-model') {
      return response.status(200).json({ status: 'succeeded', output: 'Squidward', error: null });
    }
    const result = await checkPrediction(predictionId as string);
    return response.status(200).json(result);
  }

  if (request.method === 'POST') {
    if (!songUrl && step !== 'train') {
      return response.status(400).json({ error: 'songUrl is required' });
    }

    try {
      if (step === 'train') {
        console.log('Step train: Starting RVC training...');
        console.log('OSS config:', { region: OSS_REGION, bucket: OSS_BUCKET, hasKey: !!OSS_ACCESS_KEY_ID });
        
        let datasetUrl = userVoiceUrl;
        
        if (userVoiceUrl.startsWith('data:')) {
          if (!OSS_ACCESS_KEY_ID) {
            throw new Error('OSS not configured - missing OSS_ACCESS_KEY_ID');
          }
          
          const base64 = userVoiceUrl.split(',')[1];
          const filename = `voice_${Date.now()}.wav`;
          console.log('Uploading voice to OSS...');
          datasetUrl = await uploadToOSS(base64, filename);
          console.log('Uploaded URL:', datasetUrl);
        } else if (!userVoiceUrl.startsWith('http')) {
          return response.status(400).json({ error: '需要音频URL或base64数据' });
        }
        
        console.log('Training with dataset URL:', datasetUrl);
        
        const input = {
          dataset_zip: datasetUrl,
          sample_rate: '48k',
          version: 'v2',
          f0method: 'rmvpe_gpu',
          epoch: 50,
          batch_size: 7
        };
        console.log('Starting RVC training...');
        
        const predId = await createPrediction(RVC_TRAIN_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
        
      } else if (step === '1') {
        const input = { audio: songUrl };
        console.log('Step 1 - Separation:', input);
        const predId = await createPrediction(DEMUCS_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
        
      } else if (step === '2') {
        console.log('Step 2 - Voice Conversion, model:', userVoiceUrl);
        
        const input: any = {
          song_input: songUrl,
        };
        
        if (userVoiceUrl && userVoiceUrl.startsWith('http')) {
          input.custom_rvc_model_download_url = userVoiceUrl;
          input.rvc_model = 'CUSTOM';
        } else {
          input.rvc_model = userVoiceUrl || 'Squidward';
        }
        
        console.log('RVC inference input:', input);
        
        const predId = await createPrediction(RVC_INFER_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
      } else {
        const input = { audio: songUrl };
        const predId = await createPrediction(DEMUCS_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
      }
    } catch (error) {
      console.error('Error:', error);
      return response.status(500).json({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }

  return response.status(400).json({ error: 'Invalid request' });
}
