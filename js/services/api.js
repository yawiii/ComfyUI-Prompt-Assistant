/**
 * API服务
 * 通过后端API代理调用第三方服务，保护API密钥安全
 */

import { logger } from '../utils/logger.js';

// 用于存储进行中的请求的AbortController
const runningRequests = new Map();

// ---基础路由推断逻辑---
// 自动获取当前插件的挂载点，消除硬编码路径
// 通过解析当前脚本的 URL，提取出 extensions/ 后的目录名
let apiBaseUrl = null;

function getDynamicApiBase() {
    if (apiBaseUrl) return apiBaseUrl;

    try {
        const scriptUrl = import.meta.url;
        const url = new URL(scriptUrl);
        const pathParts = url.pathname.split('/');

        // 策略1：寻找 /js/ 目录段，并取其前一个段作为插件名 (最通用)
        const jsIdx = pathParts.indexOf('js');
        if (jsIdx > 0) {
            const nodeDir = pathParts[jsIdx - 1];
            apiBaseUrl = `/${nodeDir}/api`;
        }
        // 策略2：回退到 extensions 关键词寻找 (ComfyUI 标准结构)
        else {
            const extIdx = pathParts.indexOf('extensions');
            if (extIdx !== -1 && pathParts.length > extIdx + 1) {
                const nodeDir = pathParts[extIdx + 1];
                apiBaseUrl = `/${nodeDir}/api`;
            } else {
                // 策略3：硬编码兜底
                apiBaseUrl = '/prompt-assistant/api';
            }
        }
    } catch (e) {
        apiBaseUrl = '/prompt-assistant/api';
    }
    return apiBaseUrl;
}

class APIService {
    /**
     * 获取动态 API 基础路径
     * 暴露模块级的 getDynamicApiBase 函数供外部调用
     */
    static getDynamicApiBase() {
        return getDynamicApiBase();
    }

    /**
     * 构建完整的API URL
     */
    static getApiUrl(path) {
        // 获取动态基础路由 (例如 /comfyui_prompt_assistant/api)
        const baseApi = getDynamicApiBase();

        // 确保 path 不含重复的前缀，且格式正确
        let subPath = path.startsWith('/') ? path : `/${path}`;

        // 如果 path 已经包含了 baseApi，则不再重复添加
        const fullPath = subPath.startsWith(baseApi) ? subPath : `${baseApi}${subPath}`;

        const url = `${window.location.origin}${fullPath}`;
        // logger.debug(`构建API URL: ${url}`);
        return url;
    }

    /**
     * 解析形如 [{"id":0,"text":"..."}, ...] 的JSON数组
     * 返回 Map<id, text>
     */
    static _extractIndexedTranslations(text) {
        const arr = APIService._extractJsonArray(text);
        if (!Array.isArray(arr)) return null;
        const map = new Map();
        for (const item of arr) {
            if (!item || typeof item !== 'object') return null;
            if (!('id' in item) || !('text' in item)) return null;
            map.set(Number(item.id), String(item.text ?? ''));
        }
        return map;
    }

    /**
     * 结构化批量翻译（纯前端封装，单次LLM请求）
     * 要求模型严格返回 JSON 数组，与输入 texts 一一对应
     */
    static async llmBatchTranslate(texts, from = 'auto', to = 'zh', request_id = null) {
        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('待翻译文本数组不能为空');
            }

            // 构造结构化指令，使用索引，要求输出严格的 JSON 对象数组
            const indexed = texts.map((t, i) => ({ id: i, text: t }));
            // 强化提示词：明确禁止 Markdown 表格格式，禁止添加 '|' 前缀
            const sysHint = `你是一个专业的翻译API。请将输入的 JSON 数组中的 text 字段内容从 ${from} 翻译为 ${to}。
            规则：
            1. 保持 JSON 结构不变，返回包含 id 和 text 的数组。
            2. 严禁使用 Markdown 表格格式，严禁在译文前添加 '|' 符号。
            3. 对于参数名、变量名（如 snake_case 格式），请尽可能将其翻译为中文含义（例如：pose_images -> 姿势图像），除非是专有名词（如 CLIP, VAE）。
            4. 保持数组长度与输入一致。
            5. 直接输出 JSON，不要包含 Markdown 代码块标记（如 \`\`\`json）。`;

            const payload = { segments: indexed };
            const prompt = [
                sysHint,
                'Input: ' + JSON.stringify(payload)
            ].join('\n');

            // 复用单文本接口
            const res = await this.llmTranslate(prompt, from, to, request_id);
            if (!res || !res.success) {
                return { success: false, error: res?.error || '批量翻译失败' };
            }

            const content = (res.data && (res.data.translated || res.data.expanded || res.data.content)) || res.translated || res.content || '';
            // 解析为索引映射
            let mapped = APIService._extractIndexedTranslations(content);
            if (!mapped) {
                // 回退：尝试解析为纯字符串数组并顺序对齐
                const arr = APIService._extractJsonArray(content);
                if (Array.isArray(arr) && arr.length === texts.length) {
                    mapped = new Map(arr.map((v, i) => [i, v]));
                }
            }

            if (!mapped) {
                return { success: false, error: '解析批量译文失败：未检测到有效JSON' };
            }

            // 如果缺项，针对缺失索引做单次补救调用，避免整次失败
            const translations = new Array(texts.length).fill("");
            const missingIdx = [];
            for (let i = 0; i < texts.length; i++) {
                if (mapped.has(i)) {
                    translations[i] = mapped.get(i);
                } else {
                    missingIdx.push(i);
                }
            }

            if (missingIdx.length > 0) {
                for (const i of missingIdx) {
                    const single = await this.llmTranslate(texts[i], from, to, request_id);
                    if (single && single.success) {
                        translations[i] = (single.data && single.data.translated) || '';
                    } else {
                        translations[i] = '';
                    }
                }
            }

            return { success: true, data: { translations } };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * 并行分块批量翻译（优化版本）
     * 将文本数组分块后并行发起多个翻译请求，显著提升翻译速度
     * 
     * @param {string[]} texts - 待翻译的文本数组
     * @param {string} from - 源语言
     * @param {string} to - 目标语言
     * @param {Object} options - 配置选项
     * @param {number} options.chunkSize - 每块包含的文本数量（默认5）
     * @param {number} options.concurrency - 最大并发数（默认3）
     * @param {Function} options.onProgress - 进度回调 (completedChunks, totalChunks)
     * @returns {Promise<{success: boolean, data?: {translations: string[]}, error?: string}>}
     */
    static async llmParallelBatchTranslate(texts, from = 'auto', to = 'zh', options = {}) {
        const { chunkSize = 5, concurrency = 3, onProgress = null } = options;

        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('待翻译文本数组不能为空');
            }

            // 1. 分块
            const chunks = [];
            for (let i = 0; i < texts.length; i += chunkSize) {
                chunks.push({
                    startIndex: i,
                    texts: texts.slice(i, i + chunkSize)
                });
            }

            logger.log(`[APIService] 并行分块翻译 | 总文本数:${texts.length} | 分块数:${chunks.length} | 每块:${chunkSize} | 并发:${concurrency}`);

            // 2. 创建结果数组
            const allTranslations = new Array(texts.length).fill('');
            let completedChunks = 0;
            let hasError = false;
            let lastError = null;

            // 3. 并发控制函数
            const translateChunk = async (chunk) => {
                try {
                    const result = await this.llmBatchTranslate(chunk.texts, from, to);

                    if (result.success && result.data && result.data.translations) {
                        // 将翻译结果填充到对应位置
                        result.data.translations.forEach((translation, idx) => {
                            allTranslations[chunk.startIndex + idx] = translation || '';
                        });
                    } else {
                        // 单块失败，记录但不中断
                        hasError = true;
                        lastError = result.error || '翻译失败';
                        logger.warn(`[APIService] 分块翻译失败 | 起始索引:${chunk.startIndex} | 错误:${lastError}`);
                    }
                } catch (err) {
                    hasError = true;
                    lastError = err.message;
                    logger.error(`[APIService] 分块翻译异常 | 起始索引:${chunk.startIndex} | 错误:${err.message}`);
                } finally {
                    completedChunks++;
                    if (onProgress) {
                        onProgress(completedChunks, chunks.length);
                    }
                }
            };

            // 4. 分批并发执行（控制最大并发数）
            for (let i = 0; i < chunks.length; i += concurrency) {
                const batch = chunks.slice(i, i + concurrency);
                await Promise.all(batch.map(chunk => translateChunk(chunk)));
            }

            // 5. 检查结果
            const successCount = allTranslations.filter(t => t && t.trim()).length;
            logger.log(`[APIService] 并行翻译完成 | 成功:${successCount}/${texts.length}`);

            // 即使部分失败也返回成功（有翻译结果）
            if (successCount === 0 && texts.length > 0) {
                return { success: false, error: lastError || '所有文本翻译失败' };
            }

            return { success: true, data: { translations: allTranslations } };

        } catch (error) {
            logger.error(`[APIService] 并行批量翻译失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 从字符串中提取并解析首个JSON数组
     */
    static _extractJsonArray(text) {
        if (!text) return null;
        try {
            // 快速路径：整段就是JSON数组
            if (text.trim().startsWith('[')) {
                return JSON.parse(text.trim());
            }
        } catch (_) { /* ignore */ }

        // 兼容模型添加的前后缀：寻找第一个 '[' 与匹配的 ']'
        const first = text.indexOf('[');
        const last = text.lastIndexOf(']');
        if (first === -1 || last === -1 || last <= first) return null;
        const candidate = text.slice(first, last + 1);
        try {
            return JSON.parse(candidate);
        } catch (e) {
            // 尝试修正全角引号
            const normalized = candidate.replace(/[“”]/g, '"');
            try { return JSON.parse(normalized); } catch { return null; }
        }
    }

    /**
     * 生成唯一请求ID
     */
    /**
     * 生成唯一请求ID
     * 格式: 请求类型_服务类型(可选)_NodeID_四位时间戳
     */
    static generateRequestId(type, serviceType = null, nodeId = '0') {
        const timestamp = Math.floor(Date.now() / 1000).toString().slice(-4);
        const parts = [type];
        if (serviceType) {
            parts.push(serviceType);
        }
        parts.push(nodeId);
        parts.push(timestamp);
        return parts.join('_');
    }

    /**
     * 取消一个正在进行的请求
     */
    static async cancelRequest(requestId) {
        if (!requestId) return { success: false, error: "缺少requestId" };

        const controller = runningRequests.get(requestId);

        if (controller) {
            // 1. 中止前端的fetch请求
            controller.abort();
            runningRequests.delete(requestId);
            logger.debug(`前端请求已中止 | ID: ${requestId}`);
        }

        // 2. 通知后端取消任务
        try {
            const apiUrl = this.getApiUrl('request/cancel');
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: requestId })
            });
            const result = await response.json();
            logger.debug(`后端任务取消请求已发送 | ID: ${requestId} | 结果: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error(`后端任务取消请求失败 | ID: ${requestId} | 错误: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 百度翻译API
     */
    static async baiduTranslate(text, from = 'auto', to = 'zh', request_id = null, is_auto = false) {
        // 生成请求ID
        // 生成请求ID
        if (!request_id) {
            request_id = this.generateRequestId('trans', 'baidu');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('待翻译文本不能为空');
            }

            // 获取API URL
            const apiUrl = this.getApiUrl('baidu/translate');

            // 调用后端API
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    from,
                    to,
                    request_id,
                    is_auto
                }),
                signal // 传递signal
            });

            const result = await response.json();
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`百度翻译请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            return {
                success: false,
                error: error.message
            };
        } finally {
            // 请求完成后从Map中移除
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * RU-FORK: Google Translate (публичный бесплатный эндпоинт, без ключа)
     */
    static async googleTranslate(text, from = 'auto', to = 'zh', request_id = null, is_auto = false) {
        if (!request_id) {
            request_id = this.generateRequestId('trans', 'google');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('待翻译文本不能为空');
            }

            const apiUrl = this.getApiUrl('google/translate');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    from,
                    to,
                    request_id,
                    is_auto
                }),
                signal
            });

            const result = await response.json();
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Google Translate请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`Google Translate请求失败 | ID: ${request_id} | 错误: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            runningRequests.delete(request_id);
        }
    }

    /**
     * 批量翻译
     */
    static async batchBaiduTranslate(texts, from = 'auto', to = 'zh') {
        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('待翻译文本数组不能为空');
            }

            // 串行处理每个文本的翻译
            const results = [];
            for (const text of texts) {
                const result = await this.baiduTranslate(text, from, to);
                results.push(result);
            }

            return results;
        } catch (error) {
            logger.error(`批量翻译 | 结果:失败 | 错误:${error.message}`);
            return [];
        }
    }

    /**
     * LLM扩写提示词
     */
    static async llmExpandPrompt(prompt, request_id = null) {
        // 生成请求ID
        // 生成请求ID
        if (!request_id) {
            request_id = this.generateRequestId('exp');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!prompt || prompt.trim() === '') {
                throw new Error('请输入要优化的提示词');
            }

            logger.debug(`发起LLM提示词优化请求 | 请求ID:${request_id} | 原文:${prompt}`);

            // 调用后端API
            const apiUrl = this.getApiUrl('llm/expand');
            logger.debug('LLM提示词优化API URL:', apiUrl);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt,
                    request_id
                }),
                signal // 传递signal
            });

            const result = await response.json();
            logger.debug(`LLM提示词优化请求成功 | 请求ID:${request_id} | 结果:${JSON.stringify(result)}`);

            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`LLM提示词优化请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`LLM提示词优化请求失败 | 请求ID:${request_id || 'unknown'} | 错误:${error.message}`);
            return {
                success: false,
                error: error.message
            };
        } finally {
            // 请求完成后从Map中移除
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * LLM翻译文本
     */
    static async llmTranslate(text, from = 'auto', to = 'zh', request_id = null, is_auto = false) {
        // 生成请求ID
        // 生成请求ID
        if (!request_id) {
            request_id = this.generateRequestId('trans', 'llm');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('请输入要翻译的内容');
            }

            // 调用后端API
            const apiUrl = this.getApiUrl('llm/translate');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    from,
                    to,
                    request_id,
                    is_auto
                }),
                signal // 传递signal
            });

            const result = await response.json();
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`LLM翻译请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            return {
                success: false,
                error: error.message
            };
        } finally {
            // 请求完成后从Map中移除
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * 调用视觉模型分析图像
     */
    static async llmAnalyzeImage(imageData, prompt, request_id = null) {
        // 生成请求ID
        // 生成请求ID
        if (!request_id) {
            request_id = this.generateRequestId('icap');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!imageData) {
                throw new Error('未找到有效的图像');
            }

            logger.debug(`发起视觉分析请求 | 请求ID:${request_id}`);

            // 构建API URL
            const apiUrl = this.getApiUrl('vlm/analyze');
            logger.debug('视觉分析API URL:', apiUrl);

            // 构建请求数据
            const requestData = {
                image: imageData,
                prompt: prompt, // 添加prompt
                request_id: request_id
            };

            // 发送请求
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData),
                signal // 传递signal
            });

            // 解析响应
            const result = await response.json();
            logger.debug(`视觉分析请求完成 | 请求ID:${request_id}`);

            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`视觉分析请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`视觉分析请求失败 | 请求ID:${request_id || 'unknown'} | 错误:${error.message}`);
            return {
                success: false,
                error: error.message || '请求失败'
            };
        } finally {
            // 请求完成后从Map中移除
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    // ---流式输出API方法（SSE）---

    /**
     * 流式视觉分析图像
     * 使用 SSE 逐 token 接收分析结果
     * @param {string} imageData - Base64 编码的图像数据
     * @param {string} prompt - 分析提示词
     * @param {string} request_id - 请求ID
     * @param {Function} onChunk - 接收每个 chunk 的回调函数
     * @returns {Promise<Object>} - 完整的分析结果
     */
    static async llmAnalyzeImageStream(imageData, prompt, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('icap');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!imageData) {
                throw new Error('未找到有效的图像');
            }

            logger.debug(`发起流式视觉分析请求 | 请求ID:${request_id}`);

            const apiUrl = this.getApiUrl('vlm/analyze/stream');
            const requestData = {
                image: imageData,
                prompt: prompt,
                request_id: request_id
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`解析 SSE 数据失败: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`流式视觉分析请求完成 | 请求ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`流式视觉分析请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`流式视觉分析请求失败 | 请求ID:${request_id || 'unknown'} | 错误:${error.message}`);
            return { success: false, error: error.message || '请求失败' };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * 流式LLM扩写提示词
     * 使用 SSE 逐 token 接收扩写结果
     * @param {string} prompt - 要扩写的提示词
     * @param {string} request_id - 请求ID
     * @param {Function} onChunk - 接收每个 chunk 的回调函数
     * @returns {Promise<Object>} - 完整的扩写结果
     */
    static async llmExpandPromptStream(prompt, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('exp');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!prompt || prompt.trim() === '') {
                throw new Error('请输入要优化的提示词');
            }

            logger.debug(`发起流式LLM提示词优化请求 | 请求ID:${request_id}`);

            const apiUrl = this.getApiUrl('llm/expand/stream');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, request_id }),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`解析 SSE 数据失败: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`流式LLM提示词优化请求完成 | 请求ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`流式LLM提示词优化请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`流式LLM提示词优化请求失败 | 请求ID:${request_id || 'unknown'} | 错误:${error.message}`);
            return { success: false, error: error.message };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * 流式LLM翻译
     * 使用 SSE 逐 token 接收翻译结果
     * 注意：仅支持LLM翻译服务，百度翻译不支持流式
     * @param {string} text - 要翻译的文本
     * @param {string} fromLang - 源语言
     * @param {string} toLang - 目标语言
     * @param {string} request_id - 请求ID
     * @param {Function} onChunk - 接收每个 chunk 的回调函数
     * @returns {Promise<Object>} - 完整的翻译结果
     */
    static async llmTranslateStream(text, fromLang, toLang, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('trans');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('请输入要翻译的内容');
            }

            logger.debug(`发起流式LLM翻译请求 | 请求ID:${request_id} | ${fromLang}→${toLang}`);

            const apiUrl = this.getApiUrl('llm/translate/stream');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    from: fromLang,
                    to: toLang,
                    request_id
                }),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`解析 SSE 数据失败: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`流式LLM翻译请求完成 | 请求ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`流式LLM翻译请求被用户中止 | ID: ${request_id}`);
                return { success: false, error: '请求已取消', cancelled: true };
            }
            logger.error(`流式LLM翻译请求失败 | 请求ID:${request_id || 'unknown'} | 错误:${error.message}`);
            return { success: false, error: error.message };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * 将图像转换为Base64
     */
    static async imageToBase64(img) {
        return new Promise((resolve, reject) => {
            try {
                if (!img) {
                    reject('无效的图像');
                    return;
                }

                // 如果已经是base64字符串，直接返回
                if (typeof img === 'string' && img.startsWith('data:image')) {
                    resolve(img);
                    return;
                }

                // 如果是Blob对象
                if (img instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(img);
                    return;
                }

                // 如果是URL
                if (typeof img === 'string' && (img.startsWith('http') || img.startsWith('/'))) {
                    const image = new Image();
                    image.crossOrigin = 'Anonymous';
                    image.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(image, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                    };
                    image.onerror = () => reject('图像加载失败');
                    image.src = img;
                    return;
                }

                // 处理ComfyUI图像对象
                if (img && typeof img === 'object' && img.src) {
                    // 如果图像对象有src属性，使用它
                    const image = new Image();
                    image.crossOrigin = 'Anonymous';
                    image.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(image, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                    };
                    image.onerror = (e) => {
                        console.error('图像加载失败:', e);
                        reject('图像加载失败');
                    };
                    image.src = img.src;
                    return;
                }

                // 处理HTMLImageElement或类似的对象
                if (img && (img instanceof HTMLImageElement || (img.width && img.height && img.complete))) {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                        return;
                    } catch (e) {
                        console.warn('使用canvas转换图像失败:', e);
                        // 继续尝试其他方法
                    }
                }

                // 处理ComfyUI的特殊格式 (dataURL缓存在node中)
                if (img && img.dataURL) {
                    resolve(img.dataURL);
                    return;
                }

                // 处理ComfyUI特殊的图像数据格式
                if (img && img.data && img.width && img.height) {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        const imageData = new ImageData(
                            new Uint8ClampedArray(img.data.buffer || img.data),
                            img.width,
                            img.height
                        );
                        ctx.putImageData(imageData, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                        return;
                    } catch (e) {
                        console.error('处理图像数据失败:', e);
                    }
                }

                console.error('不支持的图像格式', img);
                reject('不支持的图像格式');
            } catch (error) {
                console.error('转换图像出错:', error);
                reject(error);
            }
        });
    }
}

export { APIService }; 