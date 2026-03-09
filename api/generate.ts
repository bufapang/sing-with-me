import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 步骤1: 音乐分离 (Demucs)
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// 步骤2: 训练RVC模型
const TRAIN_RVC_VERSION = '0397d5e28c9b54665e1e5d29d5cf4f722a7b89ec20e9dbf31487235305b1a101';

// 步骤3: 歌声转换 (使用训练好的模型)
const VOICE_CLONING_VERSION = '0a9c7c558af4c0f20667c1bd1260ce32a2879944a0b9e44e1398660c077b1550';

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

  console.log('API called:', { method: request.method, predictionId, step, userVoiceUrl: userVoiceUrl ? 'provided' : 'missing' });

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

    if (!songUrl && step !== 'train') {
      return response.status(400).json({ error: 'songUrl is required' });
    }

    try {
      let input: any = {};
      let version = '';
      const currentStep = step || '1';
      
      console.log('Processing step:', currentStep);
      
      if (currentStep === 'train') {
        // 训练RVC模型
        // userVoiceUrl 是用户录音的URL
        // 我们需要先上传用户的音频到公开URL
        version = TRAIN_RVC_VERSION;
        input = {
          dataset_zip: userVoiceUrl,  // 用户录音作为训练数据
          sample_rate: '48k',
          version: 'v2',
          f0method: 'rmvpe_gpu',
          epoch: 10,  // 减少训练轮数加快速度
          batch_size: '7'
        };
        console.log('Training RVC model with input:', input);
      } else if (currentStep === '1') {
        // 步骤1: 音乐分离
        version = DEMUCS_VERSION;
        input = { audio: songUrl };
        console.log('Step 1 input:', input);
      } else if (currentStep === '2') {
        // 步骤2: 歌声转换 - 使用训练好的RVC模型
        // userVoiceUrl 是训练好的模型URL
        version = VOICE_CLONING_VERSION;
        input = {
          song_input: songUrl,  // 原始歌曲
          custom_rvc_model_download_url: userVoiceUrl,  // 训练好的模型
          rvc_model: 'CUSTOM',  // 使用自定义模型
          pitch_change: 'no-change',
          output_format: 'mp3'
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
