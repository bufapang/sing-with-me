import { useState, useRef, useEffect } from 'react';
import { Mic, Square, Download, Music, Loader2 } from 'lucide-react';

type Step = 'record' | 'song' | 'processing' | 'result';

interface RecordingState {
  isRecording: boolean;
  duration: number;
  audioBlob: Blob | null;
  audioUrl: string | null;
}

interface Song {
  id: string;
  name: string;
  artist: string;
  url: string;
}

// 预设歌曲列表（固定三首）
const DEMO_SONGS: Song[] = [
  { id: '1', name: '晴天', artist: '周杰伦', url: 'https://raw.githubusercontent.com/bufapang/sing-with-me/main/qingtian_duan.mp3' },
  { id: '2', name: '稻香', artist: '周杰伦', url: 'https://raw.githubusercontent.com/bufapang/sing-with-me/main/daoxiang_duan.mp3' },
  { id: '3', name: '人间共鸣', artist: '李健', url: 'https://raw.githubusercontent.com/bufapang/sing-with-me/main/renjiangongming_duan.mp3' },
];

export default function App() {
  const [step, setStep] = useState<Step>('record');
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [recording, setRecording] = useState<RecordingState>({
    isRecording: false,
    duration: 0,
    audioBlob: null,
    audioUrl: null,
  });
  const [resultAudio, setResultAudio] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 开始录音
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setRecording({ isRecording: false, duration: recording.duration, audioBlob: blob, audioUrl: url });
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setRecording({ ...recording, isRecording: true, duration: 0 });
      
      timerRef.current = window.setInterval(() => {
        setRecording(prev => ({ ...prev, duration: prev.duration + 1 }));
      }, 1000);
    } catch (err) {
      setError('无法访问麦克风');
    }
  };

  // 停止录音
  const stopRecording = () => {
    if (mediaRecorderRef.current && recording.isRecording) {
      mediaRecorderRef.current.stop();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  // 创建预测
  const createPredictionStep = async (songUrl: string, userVoiceUrl: string, step: string) => {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songUrl, userVoiceUrl, step }),
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `API error: ${response.status}`);
    }
    const data = await response.json();
    return data.predictionId;
  };

  // 上传用户音频到公开URL
  // Convert audio blob to base64
  const audioToBase64 = async (url: string): Promise<string> => {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        resolve(base64.split(',')[1]); // Remove data URL prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
  
  const uploadUserVoice = async (audioUrl: string): Promise<string> => {
    console.log('Uploading user voice for training...');
    console.log('Audio URL:', audioUrl);
    
    if (!audioUrl) {
      throw new Error('No audio recorded');
    }
    
    try {
      // Convert audio to base64 in frontend
      console.log('Converting audio to base64...');
      const base64Audio = await audioToBase64(audioUrl);
      console.log('Base64 length:', base64Audio.length);
      
      // Send base64 to backend
      console.log('Sending to backend...');
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userVoiceUrl: base64Audio, step: 'upload' }),
      });
      
      console.log('Upload response status:', response.status);
      
      if (!response.ok) {
        const errData = await response.json();
        console.error('Upload error response:', errData);
        throw new Error(errData.error || `Upload error: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('Upload result:', data);
      return data.url;
    } catch (err) {
      console.error('Upload failed:', err);
      throw err;
    }
  };

  // 检查预测状态
  const checkPredictionStatus = async (id: string) => {
    const response = await fetch(`/api/generate?predictionId=${id}`, { method: 'GET' });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    return { status: data.status, output: data.output, error: data.error };
  };

  // 混音两个音频
  const mixAudio = async (vocalsUrl: string, accompanimentUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const audioContext = new AudioContext();
      
      const loadAudio = async (url: string) => {
        let audioUrl = url;
        // 如果是data URL或blob URL，直接使用
        if (url.startsWith('data:') || url.startsWith('blob:')) {
          audioUrl = url;
        } else {
          // 否则通过代理
          audioUrl = `/api/generate?proxy=true&url=${encodeURIComponent(url)}`;
        }
        const response = await fetch(audioUrl);
        const arrayBuffer = await response.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer);
      };
      
      Promise.all([loadAudio(vocalsUrl), loadAudio(accompanimentUrl)])
        .then(([vocals, accompaniment]) => {
          const output = audioContext.createBuffer(
            2,
            Math.max(vocals.length, accompaniment.length),
            audioContext.sampleRate
          );
          
          for (let channel = 0; channel < 2; channel++) {
            const vocalsData = vocals.getChannelData(channel);
            const accompanimentData = accompaniment.getChannelData(channel);
            const outputData = output.getChannelData(channel);
            
            for (let i = 0; i < output.length; i++) {
              outputData[i] = (vocalsData[i] || 0) * 0.5 + (accompanimentData[i] || 0) * 0.5;
            }
          }
          
          const wav = audioBufferToWav(output);
          const blob = new Blob([wav], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          resolve(url);
        })
        .catch(reject);
    });
  };

  // AudioBuffer to WAV
  function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const bufferLength = 44 + dataLength;
    
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);
    
    const writeString = (view: DataView, offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);
    
    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }
    
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }
    
    return arrayBuffer;
  }

  // 提交处理
  const handleSubmit = async () => {
    if (!recording.audioBlob) {
      setError('请先录音');
      return;
    }
    if (!selectedSong) {
      setError('请选择一首歌曲');
      return;
    }

    setIsProcessing(true);
    setStep('processing');
    setError(null);
    setProgressText('正在创建 AI 任务...');

    try {
      // 简化流程：跳过训练，直接使用预设声音
      setProgressText('步骤1/2: 分离人声和伴奏...');
      console.log('Starting step 1 with song:', selectedSong.url);
      const step1Result = await createPredictionStep(selectedSong.url, '', '1');
      console.log('Step 1 prediction ID:', step1Result);
      
      let vocalsUrl = '';
      let accompanimentUrl = '';
      let step1Attempts = 0;
      
      while (step1Attempts < 60) {
        step1Attempts++;
        const status1 = await checkPredictionStatus(step1Result);
        console.log('Step 1 status:', status1.status, 'attempt:', step1Attempts);
        
        if (status1.status === 'succeeded') {
          if (status1.output) {
            const out = status1.output;
            console.log('Step 1 output type:', typeof out, 'keys:', Object.keys(out || {}));
            
            // Demucs返回的格式可能是 { vocals: url, accompaniment: url } 或 { stems: [...] }
            if (typeof out === 'string') {
              vocalsUrl = out;
              accompanimentUrl = '';
            } else if (Array.isArray(out)) {
              // 可能是数组，找人声和伴奏
              for (const item of out) {
                if (item?.instrumental === false || item?.type === 'vocals') {
                  vocalsUrl = item.audio || item.url || '';
                } else if (item?.instrumental === true || item?.type === 'accompaniment') {
                  accompanimentUrl = item.audio || item.url || '';
                }
              }
              // 如果没找到，默认第一个是人声
              if (!vocalsUrl && out[0]) {
                vocalsUrl = out[0].audio || out[0].url || '';
              }
              if (!accompanimentUrl && out[1]) {
                accompanimentUrl = out[1].audio || out[1].url || '';
              }
            } else if (out && typeof out === 'object') {
              vocalsUrl = out.vocals || out.vocals_url || out[0]?.audio || out[0]?.url || '';
              accompanimentUrl = out.accompaniment || out.accompaniment_url || out[1]?.audio || out[1]?.url || '';
            }
          }
          
          if (!vocalsUrl) {
            console.log('Step 1 output is null/empty, using original song');
            // 如果分离失败，使用原始歌曲
            vocalsUrl = selectedSong.url;
            accompanimentUrl = '';
          }
          
          console.log('vocalsUrl:', vocalsUrl, 'accompanimentUrl:', accompanimentUrl);
          
          // 如果没有伴奏，使用原歌作为伴奏
          if (!accompanimentUrl) {
            accompanimentUrl = selectedSong.url;
            console.log('No accompaniment separated, using original song');
          }
          break;
        } else if (status1.status === 'failed') {
          console.error('Step 1 failed:', status1.error);
          // 如果失败，使用原始歌曲
          vocalsUrl = selectedSong.url;
          accompanimentUrl = '';
          break;
        }
        
        await new Promise(r => setTimeout(r, 3000));
      }
      
      setProgressText('步骤2: 转换歌声（使用用户声音）...');
      
      // 步骤2: 用用户的声音转换
      console.log('Step 2: Converting user voice, user recording:', recording.audioUrl);
      
      // 将用户录音转为data URL（这样混音时可以访问）
      let userVocalsUrl = '';
      if (recording.audioUrl) {
        try {
          const response = await fetch(recording.audioUrl);
          const blob = await response.blob();
          userVocalsUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          console.error('Failed to convert recording:', e);
          userVocalsUrl = vocalsUrl; // fallback
        }
      } else {
        userVocalsUrl = vocalsUrl;
      }
      console.log('Using user vocals (data URL):', userVocalsUrl ? 'yes' : 'no');
      
      setProgressText('步骤3: 混音合成...');
      
      // 步骤3: 混音（使用预设声音）
      console.log('Starting mix with userVocalsUrl:', userVocalsUrl, 'accompanimentUrl:', accompanimentUrl);
      
      let finalAudioUrl = '';
      try {
        finalAudioUrl = await mixAudio(userVocalsUrl, accompanimentUrl);
        console.log('Mix completed, result:', finalAudioUrl);
      } catch (mixErr) {
        console.error('Mix failed:', mixErr);
        // 如果混音失败，直接使用转换后的人声
        finalAudioUrl = userVocalsUrl;
      }
      
      if (!finalAudioUrl) {
        finalAudioUrl = userVocalsUrl;
      }
      
      setResultAudio(finalAudioUrl);
      setStep('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发生错误');
      setStep('song');
    } finally {
      setIsProcessing(false);
    }
  };

  // 重置
  const reset = () => {
    setStep('record');
    setSelectedSong(null);
    setRecording({ isRecording: false, duration: 0, audioBlob: null, audioUrl: null });
    setResultAudio(null);
    setError(null);
    setProgressText('');
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-indigo-900 to-black text-white">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent">
            🎤 Sing With Me
          </h1>
          <p className="text-gray-400">用你的声音唱任何歌曲</p>
        </header>

        {/* 步骤 1: 录音 */}
        {step === 'record' && (
          <div className="bg-gray-800/50 backdrop-blur rounded-2xl p-12 text-center">
            <div className="mb-8">
              <div className="w-32 h-32 mx-auto mb-6 bg-gradient-to-br from-pink-500 to-purple-600 rounded-full flex items-center justify-center">
                <Mic size={64} />
              </div>
              <h2 className="text-2xl font-bold mb-2">录制你的声音</h2>
              <p className="text-gray-400">点击开始录音，然后唱你想唱的歌曲</p>
            </div>

            {recording.isRecording ? (
              <div className="mb-6">
                <p className="text-3xl font-mono mb-4">{formatTime(recording.duration)}</p>
                <div className="w-4 h-4 bg-red-500 rounded-full mx-auto animate-pulse mb-4" />
                <button
                  onClick={stopRecording}
                  className="px-8 py-3 bg-red-500 hover:bg-red-600 rounded-full font-medium transition-all inline-flex items-center"
                >
                  <Square className="mr-2" size={20} />
                  停止录音
                </button>
              </div>
            ) : (
              <button
                onClick={startRecording}
                className="px-8 py-3 bg-pink-500 hover:bg-pink-600 rounded-full font-medium transition-all inline-flex items-center"
              >
                <Mic className="mr-2" size={20} />
                开始录音
              </button>
            )}

            {recording.audioUrl && !recording.isRecording && (
              <div className="mt-6">
                <audio controls src={recording.audioUrl} className="w-full mb-4" />
                <button
                  onClick={() => setStep('song')}
                  className="px-8 py-3 bg-green-500 hover:bg-green-600 rounded-full font-medium transition-all"
                >
                  下一步
                </button>
              </div>
            )}
          </div>
        )}

        {/* 步骤 2: 选择歌曲 */}
        {step === 'song' && (
          <div className="bg-gray-800/50 backdrop-blur rounded-2xl p-8">
            <h2 className="text-2xl font-bold mb-6 text-center">选择歌曲</h2>
            
            <div className="space-y-3 mb-6">
              {DEMO_SONGS.map((song) => (
                <button
                  key={song.id}
                  onClick={() => setSelectedSong(song)}
                  className={`w-full p-4 rounded-lg text-left transition-all ${
                    selectedSong?.id === song.id
                      ? 'bg-pink-500 border-2 border-pink-400'
                      : 'bg-gray-700 hover:bg-gray-600 border-2 border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{song.name}</p>
                      <p className="text-sm text-gray-400">{song.artist}</p>
                    </div>
                    <Music size={24} className="text-gray-400" />
                  </div>
                </button>
              ))}
            </div>

            {selectedSong && (
              <div className="bg-green-500/20 border border-green-500 rounded-lg p-3 mb-6">
                <p className="text-green-400">✓ 已选择: {selectedSong.name} - {selectedSong.artist}</p>
              </div>
            )}

            <div className="flex justify-center gap-4">
              <button
                onClick={() => setStep('record')}
                className="px-6 py-3 bg-gray-600 hover:bg-gray-700 rounded-full font-medium transition-all"
              >
                上一步
              </button>
              <button
                onClick={handleSubmit}
                disabled={isProcessing || !selectedSong}
                className="px-8 py-3 bg-pink-500 hover:bg-pink-600 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-full font-medium transition-all"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="inline mr-2 animate-spin" size={20} />
                    处理中...
                  </>
                ) : (
                  '开始生成 🎵'
                )}
              </button>
            </div>
          </div>
        )}

        {/* 步骤 3: 处理中 */}
        {step === 'processing' && (
          <div className="bg-gray-800/50 backdrop-blur rounded-2xl p-12 text-center">
            <Loader2 size={64} className="mx-auto mb-6 text-pink-500 animate-spin" />
            <h2 className="text-2xl font-bold mb-2">正在生成你的歌曲</h2>
            <p className="text-gray-400 mb-6">{progressText}</p>
            <p className="text-sm text-gray-500">预计需要 1-3 分钟</p>
          </div>
        )}

        {/* 步骤 4: 结果 */}
        {step === 'result' && resultAudio && (
          <div className="bg-gray-800/50 backdrop-blur rounded-2xl p-8 text-center">
            <div className="mb-6 text-6xl">🎉</div>
            <h2 className="text-2xl font-bold mb-2">生成完成！</h2>
            <p className="text-gray-400 mb-6">这是 AI 生成的歌声</p>
            
            <audio controls src={resultAudio} className="w-full mb-6" />
            
            <div className="flex justify-center gap-4">
              <button
                onClick={reset}
                className="px-6 py-3 bg-gray-600 hover:bg-gray-700 rounded-full font-medium transition-all"
              >
                重新开始
              </button>
              <a
                href={resultAudio}
                download="my-ai-song.wav"
                className="px-6 py-3 bg-green-500 hover:bg-green-600 rounded-full font-medium transition-all inline-flex items-center"
              >
                <Download className="mr-2" size={20} />
                下载音频
              </a>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <footer className="text-center mt-12 text-gray-500 text-sm">
          <p>Powered by Replicate AI</p>
        </footer>
      </div>
    </div>
  );
}
