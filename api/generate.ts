import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 步骤1: 音乐分离 (Demucs)
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// 歌声转换 - 使用可直接传参考音频的API
const VOICE_CONVERT_VERSION = '8e84a98b4e6d461ef27d2c5aa7e8a70e7b5b8422d5e4ae4b5d7c98f6e3f9c8';

async function createPrediction(version: string, input: any): Promise<string> {
  console.log('Creating prediction with version:', version);
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
  
  console.log('Prediction created:', data.id);
  return data.id;
}

async function checkPrediction(id: string): Promise<{ status: string; output: any; error: string }> {
  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
  });
  const data = await res.json();
  console.log('Prediction status:', id, 'status:', data.status);
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

  // 音频代理
  if (request.method === 'GET' && proxy === 'true' && url) {
    console.log('Proxying audio:', url);
    await proxyAudio(url as string, response);
    return;
  }

  // 检查预测状态
  if (request.method === 'GET' && predictionId) {
    try {
      const result = await checkPrediction(predictionId as string);
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
      
      console.log('Processing step:', currentStep, 'songUrl:', songUrl ? 'provided' : 'missing');
      
      if (currentStep === '1') {
        // 步骤1: 音乐分离
        version = DEMUCS_VERSION;
        input = { audio: songUrl };
        console.log('Step 1 input:', input);
      } else if (currentStep === '2') {
        // 步骤2: 歌声转换 - 直接用用户声音作为参考
        version = VOICE_CONVERT_VERSION;
        // 这个API需要根据实际参数调整
        // 先用简单的方式：直接把用户声音和歌曲混合
        input = {
          source_audio: songUrl,
          reference_audio: userVoiceUrl
        };
        console.log('Step 2 input:', input);
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
