import type { VercelRequest, VercelResponse } from '@vercel/node';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 步骤1: 音乐分离 (Demucs)
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// 步骤2: 训练RVC模型
const TRAIN_RVC_VERSION = '0397d5e28c9b54665e1e5d29d5cf4f722a7b89ec20e9dbf31487235305b1a101';

// 歌声转换
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

// 创建zip文件用于训练
async function createTrainingZip(audioData: Buffer, filename: string): Promise<string> {
  const zip = new JSZip();
  
  // RVC训练需要特定格式: dataset/<name>/split_*.wav
  const folder = zip.folder('dataset/user_voice');
  if (folder) {
    folder.file(`split_${filename}.wav`, audioData);
  }
  
  // 生成zip
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  
  // 保存zip
  const zipPath = '/tmp/training_dataset.zip';
  fs.writeFileSync(zipPath, zipBuffer);
  console.log('Zip created at:', zipPath, 'size:', zipBuffer.length);
  
  return zipPath;
}

// 上传文件到Replicate
async function uploadFile(filePath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  
  // 使用files API
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  
  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n`,
    `Content-Type: application/zip\r\n\r\n`,
  ];
  
  const bodyStart = Buffer.from(bodyParts.join(''));
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);
  
  const uploadRes = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body
  });
  
  const uploadData = await uploadRes.json();
  console.log('Upload result:', uploadData);
  
  if (!uploadRes.ok) {
    throw new Error('Upload failed: ' + JSON.stringify(uploadData));
  }
  
  return uploadData.url;
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

  // 上传用户音频并创建训练zip
  if (request.method === 'POST' && step === 'upload') {
    if (!userVoiceUrl) {
      return response.status(400).json({ error: 'userVoiceUrl is required' });
    }
    
    try {
      let audioBuffer: Buffer;
      
      // 解析音频数据
      if (typeof userVoiceUrl === 'string' && userVoiceUrl.startsWith('data:')) {
        const base64Data = userVoiceUrl.includes(',') ? userVoiceUrl.split(',')[1] : userVoiceUrl;
        audioBuffer = Buffer.from(base64Data, 'base64');
      } else if (typeof userVoiceUrl === 'string' && userVoiceUrl.length > 200) {
        audioBuffer = Buffer.from(userVoiceUrl, 'base64');
      } else {
        const fetchRes = await fetch(userVoiceUrl as string);
        const arrayBuffer = await fetchRes.arrayBuffer();
        audioBuffer = Buffer.from(arrayBuffer);
      }
      
      console.log('Audio size:', audioBuffer.length);
      
      // 创建zip用于训练
      console.log('Creating training zip...');
      const zipPath = await createTrainingZip(audioBuffer, '001');
      
      // 上传到Replicate
      console.log('Uploading zip...');
      const uploadedUrl = await uploadFile(zipPath);
      
      console.log('Training zip URL:', uploadedUrl);
      
      return response.status(200).json({ url: uploadedUrl });
    } catch (error) {
      console.error('Upload error:', error);
      return response.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upload' });
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
        version = TRAIN_RVC_VERSION;
        input = {
          dataset_zip: userVoiceUrl,
          sample_rate: '48k',
          version: 'v2',
          f0method: 'rmvpe_gpu',
          epoch: 10,
          batch_size: '7'
        };
        console.log('Training RVC model');
      } else if (currentStep === '1') {
        version = DEMUCS_VERSION;
        input = { audio: songUrl };
      } else if (currentStep === '2') {
        version = VOICE_CLONING_VERSION;
        input = {
          song_input: songUrl,
          custom_rvc_model_download_url: userVoiceUrl,
          rvc_model: 'CUSTOM',
          pitch_change: 'no-change',
          output_format: 'mp3'
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
