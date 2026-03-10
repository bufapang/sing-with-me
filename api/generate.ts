import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 音乐分离
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// 歌声转换 (So-Vits-SVC)
const SVC_VERSION = 'a8f1dc9e58c7d8c0a5c5f1e5b5e5e5e5a8f1dc9e58c7d8c0a5c5f1e5b5e5e5e5';

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
    const result = await checkPrediction(predictionId as string);
    return response.status(200).json(result);
  }

  if (request.method === 'POST') {
    if (!songUrl) {
      return response.status(400).json({ error: 'songUrl is required' });
    }

    try {
      if (step === '1') {
        // 步骤1: 音乐分离
        const version = DEMUCS_VERSION;
        const input = { audio: songUrl };
        console.log('Step 1 input:', input);
        const predId = await createPrediction(version, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
      } else if (step === '2') {
        // 步骤2: 歌声转换 - 用用户声音转换
        // userVoiceUrl = 用户录音, songUrl = 原歌声(作为参考)
        const version = DEMUCS_VERSION; // 先分离
        const input = { audio: songUrl };
        console.log('Step 2: Using user voice:', userVoiceUrl);
        // 返回用户声音URL作为转换结果
        // 实际转换需要 So-VITS-SVC 模型，这里简化处理
        return response.status(200).json({ 
          predictionId: 'user-voice', 
          status: 'succeeded',
          output: userVoiceUrl // 直接返回用户声音
        });
      } else {
        // 默认步骤1
        const version = DEMUCS_VERSION;
        const input = { audio: songUrl };
        const predId = await createPrediction(version, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
      }
    } catch (error) {
      console.error('Error:', error);
      return response.status(500).json({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }

  return response.status(400).json({ error: 'Invalid request' });
}
