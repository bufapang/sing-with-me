import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';
const SVC_VERSION = 'f29872ee3557e0186735048f1d6de98a52518ae5c49e19453b3fdaad710bdc2b';

async function createPrediction(version: string, input: any): Promise<string> {
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
    console.error('Replicate error:', data);
    throw new Error(data.detail || 'Failed to create prediction');
  }
  
  return data.id;
}

async function checkPrediction(id: string): Promise<{ status: string; output: any; error: string }> {
  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
  });
  const data = await res.json();
  return { status: data.status, output: data.output, error: data.error };
}

// 代理下载音频文件
async function proxyAudio(url: string, res: VercelResponse) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      res.status(500).json({ error: 'Failed to fetch audio' });
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const ext = url.split('.').pop()?.toLowerCase();
    const contentType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buffer);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy audio' });
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const { songUrl, userVoiceUrl, step, predictionId, proxy, url } = request.body || request.query;

  console.log('API called:', { method: request.method, predictionId, step, songUrl: songUrl ? 'provided' : 'missing' });

  // 音频代理
  if (request.method === 'GET' && proxy === 'true' && url) {
    await proxyAudio(url as string, response);
    return;
  }

  // 检查预测状态
  if (request.method === 'GET' && predictionId) {
    try {
      console.log('Checking prediction:', predictionId);
      const result = await checkPrediction(predictionId as string);
      console.log('Prediction result:', result);
      return response.status(200).json(result);
    } catch (error) {
      console.error('Check prediction error:', error);
      return response.status(500).json({ error: 'Failed to check prediction' });
    }
  }

  // 创建预测
  if (request.method === 'POST') {
    if (!REPLICATE_API_TOKEN) {
      return response.status(500).json({ error: 'REPLICATE_API_TOKEN is not set' });
    }

    if (!songUrl) {
      return response.status(400).json({ error: 'songUrl is required' });
    }

    try {
      let input: any = {};
      let version = '';
      const currentStep = step || '1';
      
      if (currentStep === '1') {
        version = DEMUCS_VERSION;
        input = { audio: songUrl };
      } else if (currentStep === '2') {
        version = SVC_VERSION;
        input = { 
          source_audio: songUrl,
          target_singer: 'Taylor Swift',
          key_shift_mode: 0,
          pitch_shift_control: 'Auto Shift',
          diffusion_inference_steps: 1000
        };
      }
      
      const predId = await createPrediction(version, input);
      return response.status(200).json({ predictionId: predId, status: 'starting' });
    } catch (error) {
      console.error('Error:', error);
      return response.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create prediction' });
    }
  }

  return response.status(400).json({ error: 'Invalid request' });
}
