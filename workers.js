/**
 * Cloudflare Worker - Microsoft Edge TTS 服务代理
 *
 * @version 2.4.0 (稳定版)
 * @description 实现了内部自动批处理机制，优雅地处理 Cloudflare 的子请求限制。
 * API 现在可以处理任何长度的文本，不会因为"子请求过多"而失败。
 * 这是最终的生产就绪版本。
 * 
 * @features
 * - 支持流式和非流式 TTS 输出
 * - 自动文本清理和分块处理
 * - 智能批处理避免 Cloudflare 限制
 * - 兼容 OpenAI TTS API 格式
 * - 支持多种中英文语音
 */

// =================================================================================
// 配置参数
// =================================================================================

// API 密钥配置
const API_KEY = globalThis.API_KEY;

// 批处理配置 - 控制并发请求数量以避免 Cloudflare 限制
const DEFAULT_CONCURRENCY = 10; // 现在作为批处理大小使用
const DEFAULT_CHUNK_SIZE = 300; // 默认文本分块大小

// OpenAI 语音映射到 Microsoft 语音
const OPENAI_VOICE_MAP = {
  "shimmer": "zh-CN-XiaoxiaoNeural",    // 温柔女声 -> 晓晓
  "alloy": "zh-CN-YunyangNeural",       // 专业男声 -> 云扬  
  "fable": "zh-CN-YunjianNeural",       // 激情男声 -> 云健
  "onyx": "zh-CN-XiaoyiNeural",         // 活泼女声 -> 晓伊
  "nova": "zh-CN-YunxiNeural",          // 阳光男声 -> 云希
  "echo": "zh-CN-liaoning-XiaobeiNeural" // 东北女声 -> 晓北
};

let htmlContent = null; // 懒初始化，避免冷启动时占用内存

// =================================================================================
// 主事件监听器
// =================================================================================

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event));
});

/**
 * 处理所有传入的 HTTP 请求
 * @param {FetchEvent} event - Cloudflare Worker 事件对象
 * @returns {Promise<Response>} HTTP 响应
 */
async function handleRequest(event) {
  const request = event.request;

  // 处理 CORS 预检请求
  if (request.method === "OPTIONS") return handleOptions(request);

  const url = new URL(request.url);
  // 处理HTML页面请求
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!htmlContent) htmlContent = getHtmlContent();
    return new Response(htmlContent, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "public, max-age=86400" // 缓存1d
      }
    });
  }

  // API 密钥验证
  if (API_KEY) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== API_KEY) {
      return errorResponse("无效的 API 密钥", 401, "invalid_api_key");
    }
  }


  try {
    // 路由分发
    if (url.pathname === "/v1/audio/speech") return await handleSpeechRequest(request);
    if (url.pathname === "/v1/models") return handleModelsRequest();
  } catch (err) {
    console.error("请求处理器错误:", err);
    return errorResponse(err.message, 500, "internal_server_error");
  }

  return errorResponse("未找到", 404, "not_found");
}


// =================================================================================
// 路由处理器
// =================================================================================

/**
 * 处理 CORS 预检请求
 * @param {Request} request - HTTP 请求对象
 * @returns {Response} CORS 响应
 */
function handleOptions(request) {
  const headers = makeCORSHeaders(request.headers.get("Access-Control-Request-Headers"));
  return new Response(null, { status: 204, headers });
}

/**
 * 处理语音合成请求
 * @param {Request} request - HTTP 请求对象
 * @returns {Promise<Response>} 语音数据响应
 */
async function handleSpeechRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("不允许的方法", 405, "method_not_allowed");
  }

  const requestBody = await request.json();
  if (!requestBody.input) {
    return errorResponse("'input' 是必需参数", 400, "invalid_request_error");
  }

  // 解析请求参数并设置默认值
  const {
    model = "tts-1",                     // 模型名称
    input,                               // 输入文本
    voice = null,                        // 语音（OpenAI 别名或微软语音名）
    response_format = "mp3",             // 输出格式
    speed = 1.0,                         // 语速 (0.25-2.0)
    pitch = 1.0,                         // 音调 (0.5-1.5)
    style = "general",                   // 语音风格
    stream = false,                      // 是否流式输出
    concurrency = DEFAULT_CONCURRENCY,   // 并发数
    chunk_size = DEFAULT_CHUNK_SIZE,     // 分块大小
    cleaning_options = {}                // 文本清理选项
  } = requestBody;

  // 合并默认清理选项
  const finalCleaningOptions = {
    remove_markdown: true,      // 移除 Markdown
    remove_emoji: true,         // 移除 Emoji
    remove_urls: true,          // 移除 URL
    remove_line_breaks: true,   // 移除换行符
    remove_citation_numbers: true, // 移除引用数字
    custom_keywords: "",        // 自定义关键词
    ...cleaning_options
  };

  // 清理输入文本
  const cleanedInput = cleanText(input, finalCleaningOptions);

  // 语音映射：voice 别名 > model 中编码的别名 > voice 直接作为微软语音名 > 默认值
  const modelAlias = model.replace(/^tts-1-?/, '') || null;
  const finalVoice = OPENAI_VOICE_MAP[voice]
    || OPENAI_VOICE_MAP[modelAlias]
    || voice
    || "zh-CN-XiaoxiaoNeural";

  // response_format -> 微软 outputFormat + Content-Type
  const FORMAT_MAP = {
    "mp3":  { fmt: "audio-24khz-48kbitrate-mono-mp3",  ct: "audio/mpeg" },
    "opus": { fmt: "webm-24khz-16bit-mono-opus",        ct: "audio/webm" },
    "wav":  { fmt: "riff-24khz-16bit-mono-pcm",         ct: "audio/wav"  },
    "pcm":  { fmt: "raw-24khz-16bit-mono-pcm",          ct: "audio/pcm"  },
  };
  const { fmt: outputFormat, ct: contentType } = FORMAT_MAP[response_format] ?? FORMAT_MAP["mp3"];

  // 参数转换为 Microsoft TTS 格式
  const rate = ((speed - 1) * 100).toFixed(0);
  const finalPitch = ((pitch - 1) * 100).toFixed(0);

  // 智能文本分块
  const textChunks = smartChunkText(cleanedInput, chunk_size);
  const ttsArgs = [finalVoice, rate, finalPitch, style, outputFormat];

  // 根据是否流式选择处理方式
  if (stream) {
    return streamVoice(textChunks, concurrency, contentType, ...ttsArgs);
  } else {
    return await getVoice(textChunks, concurrency, contentType, ...ttsArgs);
  }
}

/**
 * 处理模型列表请求
 * @returns {Response} 可用模型列表
 */
function handleModelsRequest() {
  const CREATED_AT = 1706745600; // 固定 Unix 时间戳（秒），符合 OpenAI 规范
  const models = [
    { id: 'tts-1',    object: 'model', created: CREATED_AT, owned_by: 'openai' },
    { id: 'tts-1-hd', object: 'model', created: CREATED_AT, owned_by: 'openai' },
    ...Object.keys(OPENAI_VOICE_MAP).map(v => ({
      id: `tts-1-${v}`,
      object: 'model',
      created: CREATED_AT,
      owned_by: 'openai'
    }))
  ];
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
  });
}

// =================================================================================
// 核心 TTS 逻辑 (自动批处理机制)
// =================================================================================

/**
 * 流式语音生成
 * @param {string[]} textChunks - 文本块数组
 * @param {number} concurrency - 并发数
 * @param {string} contentType - 响应 Content-Type
 * @param {...any} ttsArgs - TTS 参数
 * @returns {Response} 流式音频响应
 */
function streamVoice(textChunks, concurrency, contentType, ...ttsArgs) {
  const { readable, writable } = new TransformStream();
  // 不 await——立即返回 Response，pipe 在后台并发执行
  pipeChunksToStream(writable.getWriter(), textChunks, concurrency, ...ttsArgs)
    .catch(err => console.error("流式 TTS 失败:", err));
  return new Response(readable, {
    headers: { "Content-Type": contentType, ...makeCORSHeaders() }
  });
}

/**
 * 将文本块流式传输到响应流
 * @param {WritableStreamDefaultWriter} writer - 写入器
 * @param {string[]} chunks - 文本块
 * @param {number} concurrency - 并发数
 * @param {...any} ttsArgs - TTS 参数
 */
async function pipeChunksToStream(writer, chunks, concurrency, ...ttsArgs) {
  try {
    // 分批处理文本块以避免超出 Cloudflare 子请求限制
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const audioPromises = batch.map(chunk => getAudioChunk(chunk, ...ttsArgs));

      // 仅等待当前批次完成
      const audioBlobs = await Promise.all(audioPromises);

      // 将音频数据写入流
      for (const blob of audioBlobs) {
        const arrayBuffer = await blob.arrayBuffer();
        writer.write(new Uint8Array(arrayBuffer));
      }
    }
  } catch (error) {
    console.error("流式 TTS 失败:", error);
    writer.abort(error);
    throw error;
  } finally {
    writer.close();
  }
}

/**
 * 非流式语音生成
 * @param {string[]} textChunks - 文本块数组
 * @param {number} concurrency - 并发数
 * @param {string} contentType - 响应 Content-Type
 * @param {...any} ttsArgs - TTS 参数
 * @returns {Promise<Response>} 完整音频响应
 */
async function getVoice(textChunks, concurrency, contentType, ...ttsArgs) {
  const allAudioBlobs = [];
  try {
    // 非流式模式也使用批处理
    for (let i = 0; i < textChunks.length; i += concurrency) {
      const batch = textChunks.slice(i, i + concurrency);
      const audioPromises = batch.map(chunk => getAudioChunk(chunk, ...ttsArgs));

      // 等待当前批次并收集结果
      const audioBlobs = await Promise.all(audioPromises);
      allAudioBlobs.push(...audioBlobs);
    }

    // 合并所有音频数据
    const concatenatedAudio = new Blob(allAudioBlobs, { type: contentType });
    return new Response(concatenatedAudio, {
      headers: { "Content-Type": contentType, ...makeCORSHeaders() }
    });
  } catch (error) {
    console.error("非流式 TTS 失败:", error);
    return errorResponse(error.message, 500, "tts_generation_error");
  }
}

/**
 * 获取单个文本块的音频数据
 * @param {string} text - 文本内容
 * @param {string} voiceName - 语音名称
 * @param {string} rate - 语速
 * @param {string} pitch - 音调
 * @param {string} style - 语音风格
 * @param {string} outputFormat - 输出格式
 * @returns {Promise<Blob>} 音频 Blob
 */
async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat) {
  const endpoint = await getEndpoint();
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = getSsml(text, voiceName, rate, pitch, style);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": endpoint.t,
      "Content-Type": "application/ssml+xml",
      "User-Agent": "okhttp/4.5.0",
      "X-Microsoft-OutputFormat": outputFormat
    },
    body: ssml
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge TTS API 错误: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.blob();
}


// =================================================================================
// 稳定的身份验证与辅助函数
// =================================================================================

// Token 缓存信息
let tokenInfo = { endpoint: null, token: null, expiredAt: null };
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60; // 提前 5 分钟刷新 Token

/**
 * 获取 Microsoft TTS 服务端点和 Token
 * @returns {Promise<Object>} 端点信息对象
 */
async function getEndpoint() {
  const now = Date.now() / 1000;

  // 检查 Token 是否仍然有效
  if (tokenInfo.token && tokenInfo.expiredAt &&
    now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
    return tokenInfo.endpoint;
  }

  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = crypto.randomUUID().replace(/-/g, "");

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Accept-Language": "zh-Hans",
        "X-ClientVersion": "4.0.530a 5fe1dc6c",
        "X-UserId": "0f04d16a175c411e",
        "X-HomeGeographicRegion": "zh-Hans-CN",
        "X-ClientTraceId": clientId,
        "X-MT-Signature": await sign(endpointUrl),
        "User-Agent": "okhttp/4.5.0",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "0",
        "Accept-Encoding": "gzip"
      }
    });

    if (!response.ok) {
      throw new Error(`获取端点失败: ${response.status}`);
    }

    const data = await response.json();

    // 解析 JWT Token 获取过期时间
    const jwt = data.t.split(".")[1];
    const decodedJwt = JSON.parse(atob(jwt));

    // 更新 Token 缓存
    tokenInfo = {
      endpoint: data,
      token: data.t,
      expiredAt: decodedJwt.exp
    };

    console.log(`成功获取新 Token，有效期 ${((decodedJwt.exp - now) / 60).toFixed(1)} 分钟`);
    return data;
  } catch (error) {
    console.error("获取端点失败:", error);

    // 如果有缓存的 Token，使用过期的 Token 作为备用
    if (tokenInfo.token) {
      console.log("使用过期的缓存 Token 作为备用");
      return tokenInfo.endpoint;
    }

    throw error;
  }
}

/**
 * 生成 Microsoft Translator 签名
 * @param {string} urlStr - 要签名的 URL
 * @returns {Promise<string>} 签名字符串
 */
async function sign(urlStr) {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, "");
  const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";

  // 构建待签名字符串
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();

  // 解码密钥并生成 HMAC 签名
  const decode = base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = bytesToBase64(signData);

  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

/**
 * HMAC-SHA256 签名
 * @param {Uint8Array} key - 密钥
 * @param {string} data - 待签名数据
 * @returns {Promise<Uint8Array>} 签名结果
 */
async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

/**
 * Base64 字符串转字节数组
 */
function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * 字节数组转 Base64 字符串
 */
function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}


// =================================================================================
// 通用工具函数
// =================================================================================

/**
 * 生成 SSML (Speech Synthesis Markup Language) 文档
 * @param {string} text - 文本内容
 * @param {string} voiceName - 语音名称
 * @param {string} rate - 语速百分比
 * @param {string} pitch - 音调百分比
 * @param {string} style - 语音风格
 * @returns {string} SSML 文档
 */
function getSsml(text, voiceName, rate, pitch, style) {
  // 先保护 break 标签
  const breakTagRegex = /<break\s+time="[^"]*"\s*\/?>|<break\s*\/?>|<break\s+time='[^']*'\s*\/?>/gi;
  const breakTags = [];
  let processedText = text.replace(breakTagRegex, (match) => {
    const placeholder = `__BREAK_TAG_${breakTags.length}__`;
    breakTags.push(match);
    return placeholder;
  });

  // 转义其他 XML 特殊字符
  const sanitizedText = processedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 恢复 break 标签
  let finalText = sanitizedText;
  breakTags.forEach((tag, index) => {
    finalText = finalText.replace(`__BREAK_TAG_${index}__`, tag);
  });

  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="en-US">
    <voice name="${voiceName}">
      <mstts:express-as style="${style}">
        <prosody rate="${rate}%" pitch="${pitch}%">${finalText}</prosody>
      </mstts:express-as>
    </voice>
  </speak>`;
}

/**
 * 智能文本分块 - 按句子边界分割文本
 * @param {string} text - 输入文本
 * @param {number} maxChunkLength - 最大分块长度
 * @returns {string[]} 文本块数组
 */
function smartChunkText(text, maxChunkLength) {
  if (!text) return [];

  const chunks = [];
  let currentChunk = "";

  // 按句子分隔符分割（支持中英文标点）
  const sentences = text.split(/([.?!,;:\n。？！，；：\r]+)/g);

  for (const part of sentences) {
    // 如果当前块加上新部分不超过限制，则添加
    if (currentChunk.length + part.length <= maxChunkLength) {
      currentChunk += part;
    } else {
      // 保存当前块并开始新块
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = part;
    }
  }

  // 添加最后一个块
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // 如果没有分块成功且文本不为空，强制按长度分割
  if (chunks.length === 0 && text.length > 0) {
    for (let i = 0; i < text.length; i += maxChunkLength) {
      chunks.push(text.substring(i, i + maxChunkLength));
    }
  }

  return chunks.filter(chunk => chunk.length > 0);
}

/**
 * 多阶段文本清理函数
 * @param {string} text - 输入文本
 * @param {Object} options - 清理选项
 * @returns {string} 清理后的文本
 */
function cleanText(text, options) {
  let cleanedText = text;

  // 阶段 1: 结构化内容移除
  if (options.remove_urls) {
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, '');
  }

  if (options.remove_markdown) {
    // 移除图片链接
    cleanedText = cleanedText.replace(/!\[.*?\]\(.*?\)/g, '');
    // 移除普通链接，保留链接文本
    cleanedText = cleanedText.replace(/\[(.*?)\]\(.*?\)/g, '$1');
    // 移除粗体和斜体
    cleanedText = cleanedText.replace(/(\*\*|__)(.*?)\1/g, '$2');
    cleanedText = cleanedText.replace(/(\*|_)(.*?)\1/g, '$2');
    // 移除代码块
    cleanedText = cleanedText.replace(/`{1,3}(.*?)`{1,3}/g, '$1');
    // 移除标题标记
    cleanedText = cleanedText.replace(/#{1,6}\s/g, '');
  }

  // 阶段 2: 自定义内容移除
  if (options.custom_keywords) {
    const keywords = options.custom_keywords
      .split(',')
      .map(k => k.trim())
      .filter(k => k);

    if (keywords.length > 0) {
      // 转义正则表达式特殊字符
      const escapedKeywords = keywords.map(k =>
        k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
      );
      const regex = new RegExp(escapedKeywords.join('|'), 'g');
      cleanedText = cleanedText.replace(regex, '');
    }
  }

  // 阶段 3: 字符移除
  if (options.remove_emoji) {
    // 移除 Emoji 表情符号
    cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, '');
  }

  // 阶段 4: 上下文感知格式清理
  if (options.remove_citation_numbers) {
    // 移除引用数字（如文末的 [1], [2] 等）
    cleanedText = cleanedText.replace(/\s\d{1,2}(?=[.。，,;；:：]|$)/g, '');
  }

  // 阶段 5: 通用格式清理
  if (options.remove_line_breaks) {
    // 移除所有多余的空白字符
    cleanedText = cleanedText.replace(/\s+/g, ' ');
  }

  // 阶段 6: 最终清理
  return cleanedText.trim();
}

/**
 * 生成错误响应
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @param {string} code - 错误代码
 * @param {string} type - 错误类型
 * @returns {Response} 错误响应对象
 */
function errorResponse(message, status, code, type = "api_error") {
  return new Response(
    JSON.stringify({
      error: { message, type, param: null, code }
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    }
  );
}

/**
 * 生成 CORS 响应头
 * @param {string} extraHeaders - 额外的允许头部
 * @returns {Object} CORS 头部对象
 */
function makeCORSHeaders(extraHeaders = "Content-Type, Authorization") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": extraHeaders,
    "Access-Control-Max-Age": "86400"
  };
}

/**
 * 获取 HTML 内容
 * @returns {string} HTML 页面内容
 */
function getHtmlContent() {
  return `<!DOCTYPE html>
<html lang="zh-Hans">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
  <title>TTS 语音合成</title>
  <!-- Google Fonts 国内镜像：fonts.loli.net（替换 fonts.googleapis.com 即可） -->
  <link rel="preconnect" href="https://fonts.loli.net" crossorigin />
  <link href="https://fonts.loli.net/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    /* =====================================================================
       Design Tokens — Light Mode Only
       ===================================================================== */
    :root {
      /* 背景 & 表面 */
      --bg:             #f5ede0;
      --bg-gradient:    linear-gradient(160deg, #fdefd8 0%, #f8e8d8 45%, #f0e8f5 100%);
      --surface:        #ffffff;
      --surface-hover:  #fdf8f3;
      --surface-inset:  #faf5ee;
      --header-bg:      linear-gradient(160deg, #fff8f0 0%, #ffffff 100%);

      /* 主色 — 赤陶橙（降饱和，不刺眼） */
      --primary:        #c25c18;
      --primary-light:  #fdf0e6;
      --primary-shadow: rgba(194, 92, 24, 0.18);

      /* 语义色 */
      --success:        #2d9e6b;
      --success-light:  #edfaf3;
      --error:          #c84040;
      --error-light:    #fdf0f0;
      --info:           #3b7dd8;
      --info-light:     #edf4ff;
      --warning:        #b96b1a;
      --warning-light:  #fff8ed;

      /* 文字 */
      --text:           #1c1917;
      --text-muted:     #78716c;
      --text-subtle:    #a8a29e;

      /* 边框 & 阴影（带暖色调） */
      --border:         #e8dfd4;
      --border-focus:   #e8620c;
      --shadow-sm:      0 1px 3px rgba(180,100,40,.08), 0 1px 2px rgba(0,0,0,.04);
      --shadow-md:      0 4px 12px rgba(180,100,40,.10), 0 2px 4px rgba(0,0,0,.05);
      --shadow-lg:      0 20px 50px rgba(180,100,40,.13), 0 6px 16px rgba(0,0,0,.06);

      /* 圆角 */
      --radius-sm:  8px;
      --radius-md:  12px;
      --radius-lg:  20px;
      --radius-xl:  24px;

      /* 字体 */
      --font: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "PingFang SC",
              "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    /* =====================================================================
       Reset & Base
       ===================================================================== */
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      background: var(--bg-gradient);
      background-attachment: fixed;
      min-height: 100vh;
      color: var(--text);
      line-height: 1.6;
      font-size: 15px;
    }

    [v-cloak] { display: none; }

    /* =====================================================================
       Layout
       ===================================================================== */
    .app-container {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 100vh;
      padding: 2.5rem 1rem 3rem;
    }

    .container {
      max-width: 820px;
      width: 100%;
      background: var(--surface);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-lg);
      border: 1px solid var(--border);
      overflow: hidden;
    }

    /* =====================================================================
       Header
       ===================================================================== */
    .page-header {
      padding: 2.2rem 2.5rem 1.8rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 1rem;
      background: var(--header-bg);
    }

    .header-icon {
      width: 44px;
      height: 44px;
      background: var(--primary-light);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--primary);
    }

    .header-text h1 {
      margin: 0;
      font-size: 1.35rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1.3;
    }

    .header-text p {
      margin: 0.2rem 0 0;
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    /* =====================================================================
       Main content area
       ===================================================================== */
    .page-body {
      padding: 2rem 2.5rem 2.5rem;
    }

    /* =====================================================================
       Section cards (replaces <details>)
       ===================================================================== */
    .section-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: 1.5rem;
      background: var(--surface);
      overflow: hidden;
    }

    .section-card summary {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.9rem 1.1rem;
      font-weight: 600;
      font-size: 0.88rem;
      color: var(--text-muted);
      cursor: pointer;
      list-style: none;
      user-select: none;
      transition: background 0.15s, color 0.15s;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .section-card summary::-webkit-details-marker { display: none; }

    .section-card summary:hover {
      background: var(--surface-hover);
      color: var(--text);
    }

    .section-card[open] summary {
      color: var(--primary);
      border-bottom: 1px solid var(--border);
    }

    .section-card summary .chevron {
      margin-left: auto;
      width: 16px;
      height: 16px;
      color: var(--text-subtle);
      transition: transform 0.2s;
    }

    .section-card[open] summary .chevron {
      transform: rotate(180deg);
    }

    .section-body {
      padding: 1.2rem 1.1rem;
      background: var(--surface-inset);
    }

    /* =====================================================================
       Form elements
       ===================================================================== */
    .form-group {
      margin-bottom: 1.25rem;
    }
    .form-group:last-child { margin-bottom: 0; }

    label {
      display: block;
      font-weight: 600;
      font-size: 0.85rem;
      margin-bottom: 0.45rem;
      color: var(--text);
      letter-spacing: 0.01em;
    }

    input[type="text"],
    input[type="password"],
    input[type="number"],
    select,
    textarea {
      width: 100%;
      padding: 0.7rem 0.9rem;
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 0.95rem;
      font-family: var(--font);
      background: var(--surface);
      color: var(--text);
      transition: border-color 0.18s, box-shadow 0.18s;
      -webkit-appearance: none;
    }

    input[type="text"]:focus,
    input[type="password"]:focus,
    input[type="number"]:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px var(--primary-shadow);
    }

    input::placeholder,
    textarea::placeholder { color: var(--text-subtle); }

    textarea {
      resize: vertical;
      min-height: 130px;
      line-height: 1.65;
    }

    select {
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2378716c' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.8rem center;
      padding-right: 2.2rem;
    }

    /* =====================================================================
       Textarea toolbar
       ===================================================================== */
    .label-with-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.45rem;
    }

    .pause-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .pause-input {
      width: 7em;
      padding: 0.35rem 0.6rem;
      border: 1.5px solid var(--border);
      border-radius: 6px;
      font-size: 0.85rem;
      text-align: center;
      font-family: var(--font);
      background: var(--surface);
      color: var(--text);
    }

    .pause-input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px var(--primary-shadow);
    }

    .btn-insert-pause {
      background: var(--primary-light);
      color: var(--primary);
      padding: 0.35rem 0.75rem;
      border: 1.5px solid transparent;
      border-radius: 6px;
      font-size: 0.82rem;
      font-weight: 600;
      font-family: var(--font);
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }

    .btn-insert-pause:hover {
      background: var(--primary);
      color: #fff;
    }

    .btn-insert-pause:active { transform: scale(0.96); }

    /* =====================================================================
       Textarea footer (char count + clear)
       ===================================================================== */
    .textarea-footer {
      margin-top: 0.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
    }

    .char-counter {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .char-count-text {
      font-size: 0.8rem;
      color: var(--text-subtle);
    }

    .char-count-text.warn  { color: var(--warning); }
    .char-count-text.danger { color: var(--error); }

    .char-bar {
      height: 3px;
      border-radius: 2px;
      background: var(--border);
      overflow: hidden;
    }

    .char-bar-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--primary);
      transition: width 0.2s, background 0.2s;
    }

    .char-bar-fill.warn   { background: var(--warning); }
    .char-bar-fill.danger { background: var(--error); }

    .clear-btn {
      background: none;
      border: none;
      color: var(--text-subtle);
      font-size: 0.8rem;
      font-family: var(--font);
      cursor: pointer;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
      flex-shrink: 0;
    }

    .clear-btn:hover { background: var(--error-light); color: var(--error); }

    /* =====================================================================
       Grid layout (voice / speed / pitch)
       ===================================================================== */
    .grid-layout {
      display: grid;
      grid-template-columns: 1.4fr 1fr 1fr;
      gap: 1.25rem;
    }

    /* =====================================================================
       Sliders
       ===================================================================== */
    .slider-group {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 0.2rem;
    }

    .slider-group input[type="range"] {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
      outline: none;
      -webkit-appearance: none;
      appearance: none;
      cursor: pointer;
    }

    .slider-group input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--primary);
      cursor: pointer;
      box-shadow: 0 1px 4px var(--primary-shadow);
      transition: transform 0.15s;
    }

    .slider-group input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }

    .slider-group input[type="range"]::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--primary);
      cursor: pointer;
      border: none;
      box-shadow: 0 1px 4px var(--primary-shadow);
    }

    .slider-value {
      font-weight: 600;
      min-width: 46px;
      text-align: right;
      color: var(--primary);
      font-size: 0.88rem;
      font-variant-numeric: tabular-nums;
    }

    /* =====================================================================
       Checkbox grid
       ===================================================================== */
    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(165px, 1fr));
      gap: 0.6rem;
    }

    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.65rem;
      border-radius: var(--radius-sm);
      border: 1.5px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      font-size: 0.88rem;
      color: var(--text);
      user-select: none;
    }

    .checkbox-item:hover {
      border-color: var(--primary);
      background: var(--primary-light);
    }

    .checkbox-item input[type="checkbox"] {
      width: 15px;
      height: 15px;
      margin: 0;
      flex-shrink: 0;
      accent-color: var(--primary);
      cursor: pointer;
    }

    /* =====================================================================
       Action buttons
       ===================================================================== */
    .button-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.85rem;
      margin-top: 1.75rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.55rem;
      padding: 0.85rem 1rem;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 0.95rem;
      font-weight: 600;
      font-family: var(--font);
      cursor: pointer;
      transition: all 0.18s;
      line-height: 1;
    }

    .btn:active { transform: scale(0.97); }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    /* 标准模式 — outline 次要按钮 */
    .btn-generate {
      background: var(--surface);
      color: var(--text);
      border: 1.5px solid var(--border);
      box-shadow: var(--shadow-sm);
    }

    .btn-generate:hover:not(:disabled) {
      border-color: var(--primary);
      color: var(--primary);
      background: var(--primary-light);
      box-shadow: var(--shadow-md);
    }

    /* 流式模式 — 填充主按钮 */
    .btn-stream {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 3px 10px var(--primary-shadow);
    }

    .btn-stream:hover:not(:disabled) {
      filter: brightness(1.08);
      box-shadow: 0 5px 16px var(--primary-shadow);
      transform: translateY(-1px);
    }

    /* 下载按钮 */
    .btn-download {
      background: var(--surface);
      color: var(--primary);
      border: 1.5px solid var(--primary);
      padding: 0.7rem 1.4rem;
      font-size: 0.9rem;
    }

    .btn-download:hover:not(:disabled) {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 4px 12px var(--primary-shadow);
    }

    /* =====================================================================
       Status banner
       ===================================================================== */
    .status {
      margin-top: 1.25rem;
      padding: 0.8rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 0.9rem;
      font-weight: 500;
      display: none;
      align-items: center;
      gap: 0.6rem;
      border: 1px solid transparent;
    }

    .status.show { display: flex; }

    .status-info    { background: var(--info-light);    color: var(--info);    border-color: rgba(59,125,216,.2);  }
    .status-success { background: var(--success-light); color: var(--success); border-color: rgba(45,158,107,.2);  }
    .status-error   { background: var(--error-light);   color: var(--error);   border-color: rgba(200,64,64,.2);   }

    /* =====================================================================
       Audio player
       ===================================================================== */
    audio {
      width: 100%;
      margin-top: 1.25rem;
      border-radius: var(--radius-sm);
      height: 44px;
    }

    .download-section {
      margin-top: 0.85rem;
      display: flex;
      justify-content: center;
    }

    /* =====================================================================
       Spinner
       ===================================================================== */
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.35);
      border-radius: 50%;
      border-top-color: currentColor;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    .btn-generate .spinner {
      border-color: rgba(0,0,0,0.15);
      border-top-color: var(--primary);
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* =====================================================================
       Divider
       ===================================================================== */
    .section-divider {
      height: 1px;
      background: var(--border);
      margin: 1.5rem 0;
    }

    /* =====================================================================
       Responsive
       ===================================================================== */
    @media (max-width: 720px) {
      .app-container { padding: 0 0 2rem; }

      .container {
        border-radius: 0;
        border-left: none;
        border-right: none;
        box-shadow: none;
        min-height: 100vh;
      }

      .page-header { padding: 1.5rem 1.25rem 1.25rem; }
      .page-body   { padding: 1.25rem 1.25rem 2rem; }

      .grid-layout { grid-template-columns: 1fr; gap: 0; }
      .button-group { grid-template-columns: 1fr; }
      .checkbox-grid { grid-template-columns: 1fr 1fr; }

      .label-with-controls { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
      .pause-controls { align-self: flex-end; }
    }

    @media (max-width: 480px) {
      .page-header { gap: 0.75rem; }
      .header-icon { width: 38px; height: 38px; }
      .header-text h1 { font-size: 1.15rem; }

      input[type="text"],
      input[type="password"],
      select,
      textarea { font-size: 16px; }

      .checkbox-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>

<body>
  <div id="app" class="app-container">
    <main class="container">

      <!-- Header -->
      <header class="page-header">
        <div class="header-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </div>
        <div class="header-text">
          <h1>TTS 语音合成</h1>
          <p>基于 Microsoft Edge TTS · 兼容 OpenAI 格式</p>
        </div>
      </header>

      <div class="page-body">

        <!-- API 配置 -->
        <details class="section-card">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            API 配置
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </summary>
          <div class="section-body">
            <div class="form-group">
              <label for="baseUrl">API Base URL</label>
              <input type="text" id="baseUrl" v-model="config.baseUrl" @input="saveConfig" placeholder="https://your-worker.workers.dev" />
            </div>
            <div class="form-group">
              <label for="apiKey">API Key</label>
              <input type="password" id="apiKey" v-model="config.apiKey" @input="saveConfig" placeholder="sk-..." />
            </div>
          </div>
        </details>

        <!-- 输入文本 -->
        <div class="form-group">
          <div class="label-with-controls">
            <label for="inputText">输入文本</label>
            <div class="pause-controls">
              <input type="number" v-model.number="pauseTime" min="0.01" max="100" step="0.01"
                placeholder="停顿秒数" class="pause-input" />
              <button type="button" @click="insertPause" class="btn-insert-pause">
                插入停顿
              </button>
            </div>
          </div>
          <textarea id="inputText" ref="textareaRef" v-model="form.inputText" @input="saveForm"
            placeholder="在此输入要转换的文本…"></textarea>
          <div class="textarea-footer">
            <div class="char-counter" v-cloak>
              <span class="char-count-text" :class="charCountClass">{{ charCount }} 字符</span>
              <div class="char-bar">
                <div class="char-bar-fill" :class="charCountClass" :style="{ width: charBarWidth }"></div>
              </div>
            </div>
            <button class="clear-btn" @click="clearText">清除</button>
          </div>
        </div>

        <!-- 音色 / 语速 / 音调 -->
        <div class="grid-layout">
          <div class="form-group">
            <label for="voice">音色</label>
            <select id="voice" v-model="form.voice" @change="saveForm">
              <!-- 普通话女声 · 按热门程度排序 -->
              <optgroup label="普通话 · 女声">
                <option value="zh-CN-XiaoxiaoNeural">晓晓（多风格 · 最热门）</option>
                <option value="zh-CN-XiaoyiNeural">晓伊（活泼）</option>
                <option value="zh-CN-XiaochenNeural">晓辰（开朗）</option>
                <option value="zh-CN-XiaohanNeural">晓涵（轻松）</option>
                <option value="zh-CN-XiaorouNeural">晓柔（温柔）</option>
                <option value="zh-CN-XiaoyanNeural">晓颜（专业）</option>
                <option value="zh-CN-XiaoqiuNeural">晓秋（沉稳）</option>
                <option value="zh-CN-XiaozhenNeural">晓甄（激情）</option>
                <option value="zh-CN-XiaomengNeural">晓梦</option>
                <option value="zh-CN-XiaomoNeural">晓墨</option>
                <option value="zh-CN-XiaoruiNeural">晓睿（年长）</option>
                <option value="zh-CN-XiaoshuangNeural">晓双（儿童）</option>
                <option value="zh-CN-XiaoyouNeural">晓悠（儿童）</option>
              </optgroup>
              <!-- 普通话男声 · 按热门程度排序 -->
              <optgroup label="普通话 · 男声">
                <option value="zh-CN-YunyangNeural">云扬（专业 · 最热门）</option>
                <option value="zh-CN-YunxiNeural">云希（阳光）</option>
                <option value="zh-CN-YunjianNeural">云健（激情）</option>
                <option value="zh-CN-YunjieNeural">云杰</option>
                <option value="zh-CN-YunfengNeural">云枫</option>
                <option value="zh-CN-YunhaoNeural">云皓</option>
                <option value="zh-CN-YunzeNeural">云泽（浑厚）</option>
                <option value="zh-CN-YunyeNeural">云野</option>
                <option value="zh-CN-YunxiaNeural">云夏（儿童）</option>
              </optgroup>
              <!-- 地方方言 -->
              <optgroup label="地方方言">
                <option value="zh-CN-liaoning-XiaobeiNeural">晓北（辽宁 · 女）</option>
                <option value="zh-CN-liaoning-YunbiaoNeural">云彪（辽宁 · 男）</option>
                <option value="zh-CN-shaanxi-XiaoniNeural">晓妮（陕西 · 女）</option>
                <option value="zh-CN-henan-YundengNeural">云登（河南 · 男）</option>
                <option value="zh-CN-shandong-YunxiangNeural">云翔（山东 · 男）</option>
                <option value="zh-CN-sichuan-YunxiNeural">云希（四川 · 男）</option>
                <option value="zh-CN-guangxi-YunqiNeural">云琦（广西 · 男）</option>
              </optgroup>
              <!-- 台湾普通话 -->
              <optgroup label="台湾普通话">
                <option value="zh-TW-HsiaoChenNeural">曉臻（女）</option>
                <option value="zh-TW-HsiaoYuNeural">曉雨（女）</option>
                <option value="zh-TW-YunJheNeural">雲哲（男）</option>
              </optgroup>
              <!-- 粤语 -->
              <optgroup label="粤语（香港）">
                <option value="zh-HK-HiuMaanNeural">曉曼（女）</option>
                <option value="zh-HK-HiuGaaiNeural">曉佳（女）</option>
                <option value="zh-HK-WanLungNeural">雲龍（男）</option>
              </optgroup>
              <!-- 英文女声 -->
              <optgroup label="英文 · 女声 (en-US)">
                <option value="en-US-JennyNeural">Jenny（最热门）</option>
                <option value="en-US-AriaNeural">Aria</option>
                <option value="en-US-MichelleNeural">Michelle</option>
                <option value="en-US-MonicaNeural">Monica</option>
                <option value="en-US-NancyNeural">Nancy</option>
                <option value="en-US-SaraNeural">Sara</option>
                <option value="en-US-AmberNeural">Amber</option>
                <option value="en-US-AshleyNeural">Ashley</option>
                <option value="en-US-CoraNeural">Cora</option>
                <option value="en-US-ElizabethNeural">Elizabeth</option>
                <option value="en-US-JaneNeural">Jane</option>
                <option value="en-US-AnaNeural">Ana（儿童）</option>
              </optgroup>
              <!-- 英文男声 -->
              <optgroup label="英文 · 男声 (en-US)">
                <option value="en-US-GuyNeural">Guy（最热门）</option>
                <option value="en-US-DavisNeural">Davis</option>
                <option value="en-US-ChristopherNeural">Christopher</option>
                <option value="en-US-EricNeural">Eric</option>
                <option value="en-US-RogerNeural">Roger</option>
                <option value="en-US-SteffanNeural">Steffan</option>
                <option value="en-US-BrandonNeural">Brandon</option>
                <option value="en-US-JasonNeural">Jason</option>
                <option value="en-US-TonyNeural">Tony</option>
                <option value="en-US-JacobNeural">Jacob</option>
              </optgroup>
            </select>
          </div>
          <div class="form-group">
            <label>语速</label>
            <div class="slider-group">
              <input type="range" v-model.number="form.speed" @input="saveForm" min="0.25" max="2.0" step="0.05" />
              <span class="slider-value" v-cloak>{{ speedDisplay }}</span>
            </div>
          </div>
          <div class="form-group">
            <label>音调</label>
            <div class="slider-group">
              <input type="range" v-model.number="form.pitch" @input="saveForm" min="0.5" max="1.5" step="0.05" />
              <span class="slider-value" v-cloak>{{ pitchDisplay }}</span>
            </div>
          </div>
        </div>

        <!-- 高级清理选项 -->
        <details class="section-card">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            高级文本清理
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </summary>
          <div class="section-body">
            <div class="checkbox-grid">
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeMarkdown" @change="saveForm" />
                移除 Markdown
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeEmoji" @change="saveForm" />
                移除 Emoji
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeUrls" @change="saveForm" />
                移除 URL
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeLineBreaks" @change="saveForm" />
                移除空白换行
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeCitation" @change="saveForm" />
                移除引用数字
              </label>
            </div>
            <div class="form-group" style="margin-top: 1rem;">
              <label for="customKeywords">自定义移除关键词（逗号分隔）</label>
              <input type="text" id="customKeywords" v-model="form.cleaning.customKeywords"
                @input="saveForm" placeholder="例如：广告词,品牌名" />
            </div>
          </div>
        </details>

        <!-- 操作按钮 -->
        <div class="button-group">
          <button class="btn btn-generate" v-cloak :disabled="isLoading" @click="generateSpeech(false)">
            <span v-if="isLoading && !isStreaming" class="spinner"></span>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            {{ isLoading && !isStreaming ? '生成中…' : '生成语音' }}
          </button>
          <button class="btn btn-stream" v-cloak :disabled="isLoading" @click="generateSpeech(true)">
            <span v-if="isLoading && isStreaming" class="spinner"></span>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            {{ isLoading && isStreaming ? '流式播放中…' : '流式生成' }}
          </button>
        </div>

        <!-- 状态提示 -->
        <div class="status" :class="['status-' + status.type, { show: status.show }]" v-cloak>
          {{ status.message }}
        </div>

        <!-- 播放器 -->
        <audio ref="audioPlayer" controls v-show="audioSrc" v-cloak :src="audioSrc"
          @loadstart="onAudioLoadStart" @canplay="onAudioCanPlay"></audio>

        <!-- 下载 -->
        <div v-if="showDownloadBtn" class="download-section" v-cloak>
          <button class="btn btn-download" @click="downloadAudio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            下载音频
          </button>
        </div>

      </div><!-- /.page-body -->
    </main>
  </div>

  <!-- Vue 3 CDN (unpkg 在国内一般可访问) -->
  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>

  <script>
    const { createApp } = Vue;
    const CHAR_WARN  = 10000;
    const CHAR_LIMIT = 15000;

    createApp({
      data() {
        return {
          isLoading: false,
          isStreaming: false,
          audioSrc: '',
          downloadUrl: '',
          showDownloadBtn: false,
          pauseTime: 1.0,
          config: {
            baseUrl: '',
            apiKey: ''
          },
          form: {
            inputText: '',
            voice: 'zh-CN-XiaoxiaoNeural',
            speed: 1.0,
            pitch: 1.0,
            cleaning: {
              removeMarkdown: true,
              removeEmoji: true,
              removeUrls: true,
              removeLineBreaks: true,
              removeCitation: true,
              customKeywords: ''
            }
          },
          status: { show: false, message: '', type: 'info' }
        };
      },
      computed: {
        charCount()    { return this.form.inputText.length; },
        speedDisplay() { return this.form.speed.toFixed(2); },
        pitchDisplay() { return this.form.pitch.toFixed(2); },
        charCountClass() {
          if (this.charCount >= CHAR_LIMIT) return 'danger';
          if (this.charCount >= CHAR_WARN)  return 'warn';
          return '';
        },
        charBarWidth() {
          const pct = Math.min(this.charCount / CHAR_LIMIT * 100, 100);
          return pct + '%';
        }
      },
      methods: {
        loadConfig() {
          try {
            const saved = localStorage.getItem('tts_config');
            if (saved) {
              this.config = { ...this.config, ...JSON.parse(saved) };
              if (this.config.baseUrl.endsWith('/')) {
                this.config.baseUrl = this.config.baseUrl.slice(0, -1);
              }
            }
          } catch (e) { console.warn('Failed to load config:', e); }
        },
        saveConfig() {
          try { localStorage.setItem('tts_config', JSON.stringify(this.config)); }
          catch (e) { console.warn('Failed to save config:', e); }
        },
        loadForm() {
          try {
            const saved = localStorage.getItem('tts_form');
            if (saved) this.form = { ...this.form, ...JSON.parse(saved) };
          } catch (e) { console.warn('Failed to load form:', e); }
        },
        saveForm() {
          try { localStorage.setItem('tts_form', JSON.stringify(this.form)); }
          catch (e) { console.warn('Failed to save form:', e); }
        },
        clearText() { this.form.inputText = ''; this.saveForm(); },
        downloadAudio() {
          if (!this.downloadUrl) return;
          const link = document.createElement('a');
          link.href = this.downloadUrl;
          const ts = new Date().toLocaleString('sv').replace(/[: ]/g, '-');
          link.download = 'tts-' + ts + '.mp3';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        },
        updateStatus(message, type = 'info') {
          this.status = { show: true, message, type };
        },
        getRequestBody() {
          return {
            voice: this.form.voice,
            input: this.form.inputText.trim(),
            speed: this.form.speed,
            pitch: this.form.pitch,
            cleaning_options: {
              remove_markdown:        this.form.cleaning.removeMarkdown,
              remove_emoji:           this.form.cleaning.removeEmoji,
              remove_urls:            this.form.cleaning.removeUrls,
              remove_line_breaks:     this.form.cleaning.removeLineBreaks,
              remove_citation_numbers: this.form.cleaning.removeCitation,
              custom_keywords:        this.form.cleaning.customKeywords,
            }
          };
        },
        async generateSpeech(isStream) {
          const baseUrl = this.config.baseUrl.trim();
          const apiKey  = this.config.apiKey.trim();
          const text    = this.form.inputText.trim();
          if (!baseUrl || !apiKey || !text) {
            this.updateStatus('请填写 API 配置和输入文本', 'error');
            return;
          }
          const body = { ...this.getRequestBody(), stream: isStream };
          this.isLoading    = true;
          this.isStreaming  = isStream;
          this.audioSrc     = '';
          this.showDownloadBtn = false;
          if (this.downloadUrl) { URL.revokeObjectURL(this.downloadUrl); this.downloadUrl = ''; }
          this.updateStatus('正在连接服务器…', 'info');
          try {
            if (isStream) await this.playStreamWithMSE(baseUrl, apiKey, body);
            else          await this.playStandard(baseUrl, apiKey, body);
          } catch (err) {
            console.error(err);
            this.updateStatus('错误：' + err.message, 'error');
          } finally {
            this.isLoading   = false;
            this.isStreaming = false;
          }
        },
        async playStandard(baseUrl, apiKey, body) {
          const res = await fetch(baseUrl + '/v1/audio/speech', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!res.ok) {
            const d = await res.json();
            throw new Error(d.error?.message || 'HTTP ' + res.status);
          }
          const blob = await res.blob();
          this.audioSrc    = URL.createObjectURL(blob);
          this.downloadUrl = this.audioSrc;
          this.showDownloadBtn = true;
          this.updateStatus('生成完毕，正在播放…', 'success');
          this.$nextTick(() => this.$refs.audioPlayer.play().catch(() => {}));
        },
        async playStreamWithMSE(baseUrl, apiKey, body) {
          const mediaSource = new MediaSource();
          this.audioSrc = URL.createObjectURL(mediaSource);
          const audioChunks = [];
          return new Promise((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', async () => {
              URL.revokeObjectURL(this.audioSrc);
              const sb = mediaSource.addSourceBuffer('audio/mpeg');
              try {
                const res = await fetch(baseUrl + '/v1/audio/speech', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                if (!res.ok) {
                  const d = await res.json();
                  throw new Error(d.error?.message || 'HTTP ' + res.status);
                }
                this.updateStatus('已连接，正在接收数据…', 'info');
                this.$nextTick(() => this.$refs.audioPlayer.play().catch(() => {}));
                const reader = res.body.getReader();
                const pump = async () => {
                  const { done, value } = await reader.read();
                  if (done) {
                    if (mediaSource.readyState === 'open' && !sb.updating) mediaSource.endOfStream();
                    this.downloadUrl = URL.createObjectURL(new Blob(audioChunks, { type: 'audio/mpeg' }));
                    this.showDownloadBtn = true;
                    this.updateStatus('播放完毕，可下载保存', 'success');
                    resolve();
                    return;
                  }
                  audioChunks.push(value.slice());
                  if (sb.updating) {
                    await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
                  }
                  sb.appendBuffer(value);
                  this.updateStatus('正在流式播放…', 'success');
                };
                sb.addEventListener('updateend', pump);
                await pump();
              } catch (err) {
                this.updateStatus('错误：' + err.message, 'error');
                if (mediaSource.readyState === 'open') try { mediaSource.endOfStream(); } catch (_) {}
                reject(err);
              }
            }, { once: true });
          });
        },
        onAudioLoadStart() {},
        onAudioCanPlay() {},
        insertPause() {
          const ta = this.$refs.textareaRef;
          if (!ta) return;
          if (!this.pauseTime || this.pauseTime <= 0 || this.pauseTime > 100) {
            alert('停顿时间必须在 0.01 到 100 秒之间');
            return;
          }
          const s = ta.selectionStart, e = ta.selectionEnd;
          const tag = '<break time="' + this.pauseTime + 's"/>';
          this.form.inputText = this.form.inputText.slice(0, s) + tag + this.form.inputText.slice(e);
          this.$nextTick(() => { ta.focus(); ta.setSelectionRange(s + tag.length, s + tag.length); });
        }
      },
      mounted() { this.loadConfig(); this.loadForm(); },
      beforeUnmount() {
        if (this.audioSrc)   URL.revokeObjectURL(this.audioSrc);
        if (this.downloadUrl && this.downloadUrl !== this.audioSrc) URL.revokeObjectURL(this.downloadUrl);
      }
    }).mount('#app');
  </script>
</body>

</html>
`;
}
