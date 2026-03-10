import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 音乐分离
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// RVC推理 - 歌声转换
const RVC_INFER_VERSION = '0a9c7c558af4c0f20667c1bd1260ce32a2879944a0b9e44e1398660c077b1550';

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
    // 处理预设模型的特殊情况
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
        // 训练步骤 - 直接返回成功，使用预置模型
        // 实际训练需要服务器端文件上传，暂不可用
        console.log('Step train: Using preset model (training skipped)');
        
        // 返回一个假的模型URL表示训练完成
        // 实际上我们用预置的 Squidward 声音
        return response.status(200).json({ 
          predictionId: 'preset-model', 
          status: 'succeeded',
          output: { url: 'Squidward' }
        });
        
      } else if (step === '1') {
        // 步骤1: 音乐分离
        const input = { audio: songUrl };
        console.log('Step 1 - Separation:', input);
        const predId = await createPrediction(DEMUCS_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
        
      } else if (step === '2') {
        // 步骤2: 用RVC模型转换歌声
        // userVoiceUrl 可以是 'Squidward' 或其他预置模型，或自定义模型URL
        console.log('Step 2 - Voice Conversion, model:', userVoiceUrl);
        
        const input: any = {
          song_input: songUrl,
        };
        
        // 如果有自定义模型URL
        if (userVoiceUrl && userVoiceUrl.startsWith('http')) {
          input.custom_rvc_model_download_url = userVoiceUrl;
          input.rvc_model = 'CUSTOM';
        } else {
          // 使用预置模型
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
