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
  return `__HTML_CONTENT__`;
}
