import type { VercelRequest, VercelResponse } from '@vercel/node';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// 音乐分离
const DEMUCS_VERSION = 'b84861ae9b787409ef92927b5a07704fda87a0a7762e9bb7b09c517357eadb53';

// RVC训练
const RVC_TRAIN_VERSION = 'cf360587a27f67500c30fc31de1e0f0f9aa26dcd7b866e6ac937a07bd104bad9';

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

// 上传文件到Replicate
async function uploadToReplicate(filePath: string): Promise<string> {
  console.log('Uploading file to Replicate:', filePath);
  
  // 读取本地文件
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  
  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="audio.mp3"\r\n`,
    `Content-Type: audio/mpeg\r\n\r\n`,
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

// 创建训练zip
async function createTrainingZip(audioData: Buffer): Promise<string> {
  const zip = new JSZip();
  
  // RVC训练需要特定格式: dataset/<name>/split_*.wav
  const folder = zip.folder('dataset/user_voice');
  if (folder) {
    folder.file('split_001.wav', audioData);
  }
  
  // 生成zip
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  
  // 保存
  const zipPath = '/tmp/training_dataset.zip';
  fs.writeFileSync(zipPath, zipBuffer);
  console.log('Training zip created, size:', zipBuffer.length);
  
  return zipPath;
}

// 从URL创建训练zip
async function createTrainingZipFromUrl(audioUrl: string): Promise<string> {
  console.log('Downloading audio from:', audioUrl);
  const response = await fetch(audioUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  return createTrainingZip(buffer);
}

// 上传训练文件
async function uploadTrainingFile(zipPath: string): Promise<string> {
  console.log('Uploading training file from:', zipPath);
  const fileBuffer = fs.readFileSync(zipPath);
  console.log('File size:', fileBuffer.length);
  
  // 使用 FormData
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: 'application/zip' });
  formData.append('file', blob, 'dataset.zip');
  
  const uploadRes = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_TOKEN}`,
    },
    body: formData
  });
  
  const uploadData = await uploadRes.json();
  console.log('Upload response status:', uploadRes.status);
  console.log('Upload result:', JSON.stringify(uploadData));
  
  if (!uploadRes.ok) {
    console.error('Upload failed:', uploadData);
    throw new Error('Upload training file failed: ' + JSON.stringify(uploadData));
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
    if (!songUrl && step !== 'train') {
      return response.status(400).json({ error: 'songUrl is required' });
    }

    try {
      if (step === 'train') {
        // 步骤0: 训练RVC模型
        console.log('Step train: Uploading user voice for training...');
        
        // 下载用户声音
        let audioBuffer: Buffer;
        if (userVoiceUrl.startsWith('data:')) {
          // base64
          const base64 = userVoiceUrl.split(',')[1];
          audioBuffer = Buffer.from(base64, 'base64');
        } else {
          const resp = await fetch(userVoiceUrl);
          audioBuffer = Buffer.from(await resp.arrayBuffer());
        }
        
        // 创建训练zip
        const zipPath = await createTrainingZip(audioBuffer);
        
        // 上传到Replicate
        const uploadedUrl = await uploadTrainingFile(zipPath);
        console.log('Training file URL:', uploadedUrl);
        
        // 开始训练
        const input = {
          dataset_zip: uploadedUrl,
          sample_rate: '48k',
          version: 'v2',
          f0method: 'rmvpe_gpu',
          epoch: 50,
          batch_size: 7
        };
        console.log('Starting RVC training with input:', input);
        
        const predId = await createPrediction(RVC_TRAIN_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
        
      } else if (step === '1') {
        // 步骤1: 音乐分离
        const input = { audio: songUrl };
        console.log('Step 1 - Separation:', input);
        const predId = await createPrediction(DEMUCS_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
        
      } else if (step === '2') {
        // 步骤2: 用训练好的模型转换歌声
        // userVoiceUrl 是训练好的模型URL
        console.log('Step 2 - Voice Conversion, model:', userVoiceUrl);
        
        const input = {
          song_input: songUrl,
          custom_rvc_model_download_url: userVoiceUrl,
          rvc_model: 'CUSTOM',
        };
        console.log('RVC inference input:', input);
        
        const predId = await createPrediction(RVC_INFER_VERSION, input);
        return response.status(200).json({ predictionId: predId, status: 'starting' });
      } else {
        // 默认步骤1
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
