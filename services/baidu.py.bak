import random
import httpx
from hashlib import md5
import json
import time
import re
from typing import Optional, Dict, Any, List
import asyncio
from ..utils.common import BAIDU_ERROR_CODE_MESSAGES, ProgressBar, log_complete, log_error, TASK_TRANSLATE
from .core import HTTPClientPool

class BaiduTranslateService:
    @staticmethod
    def split_text_by_paragraphs(text, max_length=2000):
        """
        按段落分割文本，处理长文本翻译
        使用正则表达式匹配连续的换行符，与JavaScript版本保持一致
        """
        if not text:
            return []

        # 保留原始的换行符，用于后续恢复格式
        # 先将文本按换行符分割为行
        lines = text.split('\n')
        chunks = []
        current_chunk = ""
        
        for line in lines:
            # 如果当前行本身超过最大长度，需要再次分割
            if len(line) > max_length:
                # 如果current_chunk不为空，先添加到chunks
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = ""
                
                # 分割长行
                remaining_text = line
                while len(remaining_text) > 0:
                    chunk_text = remaining_text[:max_length]
                    chunks.append(chunk_text)
                    remaining_text = remaining_text[max_length:]
            # 如果添加当前行会超出长度限制，先保存当前chunk
            elif current_chunk and (len(current_chunk) + len(line) + 1 > max_length):
                chunks.append(current_chunk)
                current_chunk = line
            # 否则，添加到当前chunk
            else:
                if current_chunk:
                    current_chunk += "\n" + line
                else:
                    current_chunk = line
        
        # 添加最后一个chunk
        if current_chunk:
            chunks.append(current_chunk)
        
        return chunks

    @staticmethod
    async def translate_chunk(client, chunk, app_id, secret_key, from_lang, to_lang, retry_count=1):
        """
        异步翻译单个文本块，带重试机制
        """
        for attempt in range(retry_count):
            try:
                # 生成签名
                salt = random.randint(32768, 65536)
                sign = md5((app_id + chunk + str(salt) + secret_key).encode('utf-8')).hexdigest()
                
                # 构建请求
                url = 'https://fanyi-api.baidu.com/api/trans/vip/translate'
                params = {
                    'q': chunk,
                    'from': from_lang,
                    'to': to_lang,
                    'appid': app_id,
                    'salt': salt,
                    'sign': sign
                }
                
                # 发送异步请求
                response = await client.post(url, data=params)
                
                if response.status_code != 200:
                    if attempt < retry_count - 1:
                        await asyncio.sleep(1)
                        continue
                    raise Exception(f"百度: HTTP请求失败，状态码: {response.status_code}")

                result = response.json()
            
                # 检查错误
                if 'error_code' in result:
                    error_code = result['error_code']
                    error_message = BAIDU_ERROR_CODE_MESSAGES.get(
                        error_code, 
                        f"未知错误(错误码:{error_code})"
                    )
                    
                    # 某些错误码可以重试
                    if error_code in ['54003', '52001', '52002'] and attempt < retry_count - 1:
                        await asyncio.sleep(1)
                        continue
                        
                    raise Exception(f"百度: {error_message}")

                # 处理翻译结果
                if 'trans_result' in result and result['trans_result']:
                    translated_parts = [item['dst'] for item in result['trans_result']]
                    return '\n'.join(translated_parts)
                else:
                    raise Exception("百度: 翻译结果为空")
                    
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                if attempt < retry_count - 1:
                    from ..utils.common import WARN_PREFIX
                    print(f"\r{WARN_PREFIX} 百度翻译请求遇到网络错误，尝试重试 ({attempt+1}/{retry_count}): {e}")
                    await asyncio.sleep(1)
                else:
                    raise Exception(f"百度: 网络请求失败，请检查网络连接或稍后再试 ({type(e).__name__})")
            except Exception as e:
                if attempt < retry_count - 1:
                    await asyncio.sleep(1)
                else:
                    if str(e).startswith("百度:"):
                        raise e
                    else:
                        raise Exception(f"百度: 翻译过程中发生未知错误 ({type(e).__name__})")
                    
        raise Exception("百度: 超过最大重试次数")

    @staticmethod
    async def translate(text, from_lang='auto', to_lang='zh', request_id=None, is_auto=False, cancel_event=None, task_type=None, source=None):
        """
        异步调用百度翻译API进行翻译
        
        参数:
            task_type: 任务类型，用于统一日志输出
            cancel_event: 中断事件(保持接口一致性,百度翻译暂不支持中断)
        """
        try:
            request_id = request_id or f"baidu_trans_{int(time.time())}_{random.randint(1000, 9999)}"
            
            if not text or text.strip() == '':
                return {"success": False, "error": "百度: 待翻译文本不能为空"}
            
            from ..config_manager import config_manager
            config = config_manager.get_baidu_translate_config()
            
            app_id = config.get('app_id')
            secret_key = config.get('secret_key')
            
            if not app_id or not secret_key:
                return {"success": False, "error": "百度: 请先配置百度翻译API的APP_ID和SECRET_KEY"}

            # 确定任务类型
            task_type = task_type or TASK_TRANSLATE

            text_chunks = BaiduTranslateService.split_text_by_paragraphs(text)
            if not text_chunks:
                text_chunks = [text]

            translated_parts = []
            
            # 获取HTTP客户端（复用连接池，不使用代理）
            # 注意：百度API通常在国内直连更快，所以不配置proxy参数
            client = HTTPClientPool.get_client(
                provider="baidu_translate",
                base_url="https://fanyi-api.baidu.com",
                timeout=10.0
            )
            
            # 由于HTTPClientPool.get_client返回的是AsyncClient实例，我们可以直接使用
            # 但为了确保不使用系统代理（模拟 trust_env=False），我们需要在get_client中支持或在这里手动创建
            # 考虑到HTTPClientPool目前的设计，我们直接手动创建一个不使用代理的客户端可能更稳妥
            # 或者修改HTTPClientPool支持 trust_env=False。
            # 为了保持统一，我们使用HTTPClientPool，但如果需要强制直连，我们可以传递特定的代理配置
            
            # 实际上，HTTPClientPool.get_client 如果没有传proxy，会使用系统代理。
            # 百度翻译之前的实现是 trust_env=False (禁用系统代理)。
            # 为了保持一致，我们这里手动创建一个专用的客户端，或者修改HTTPClientPool。
            # 考虑到百度翻译的特殊性（国内直连），手动创建一个简单的客户端是最安全的迁移方式。
            
            # 创建统一进度条
            from ..server import is_streaming_progress_enabled
            pbar = ProgressBar(
                request_id=request_id,
                service_name="百度翻译",
                streaming=is_streaming_progress_enabled(),
                extra_info=f"长度:{len(text)}",
                task_type=task_type,
                source=source
            )
            
            start_time = time.perf_counter()
            
            async with httpx.AsyncClient(trust_env=False, verify=False, timeout=10.0) as client:
                for i, chunk in enumerate(text_chunks):
                    # ---中断监控---
                    is_interrupted = False
                    if cancel_event is not None and cancel_event.is_set():
                        is_interrupted = True
                    else:
                        try:
                            from server import PromptServer
                            if hasattr(PromptServer.instance, 'execution_interrupted') and PromptServer.instance.execution_interrupted:
                                is_interrupted = True
                        except: pass
                    
                    if is_interrupted:
                        pbar.cancel(f"{WARN_PREFIX} 任务被中断 | 服务:百度翻译")
                        return {"success": False, "error": "任务被中断", "interrupted": True}
                    # ------------

                    try:
                        chunk_translation = await BaiduTranslateService.translate_chunk(
                            client, chunk, app_id, secret_key, from_lang, to_lang
                        )
                        translated_parts.append(chunk_translation)

                        if i < len(text_chunks) - 1:
                            await asyncio.sleep(1)

                    except Exception as chunk_error:
                        # 输出错误日志
                        pbar.error(str(chunk_error))
                        return {"success": False, "error": str(chunk_error)}
            
            translated_text = '\n'.join(translated_parts)
            # 完成阶段
            elapsed = int((time.perf_counter() - start_time) * 1000)
            pbar.done(char_count=len(translated_text), elapsed_ms=elapsed)

            return {
                "success": True,
                "data": {
                    "translated": translated_text,
                    "from": from_lang,
                    "to": to_lang,
                    "original": text
                }
            }
            
        # 关键修复：单独捕获外层 CancelledError，确保 pbar 被正确停止
        except asyncio.CancelledError:
            if 'pbar' in locals() and pbar:
                pbar.cancel(f"{WARN_PREFIX} 任务被外部取消 | 服务:百度翻译")
            return {"success": False, "error": "任务被取消", "interrupted": True}
        
        except Exception as e:
            # 输出错误日志
            if 'pbar' in locals() and pbar:
                pbar.error(str(e))
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def batch_translate(texts, from_lang='auto', to_lang='zh'):
        """
        异步批量翻译文本
        """
        tasks = [BaiduTranslateService.translate(text, from_lang, to_lang) for text in texts]
        return await asyncio.gather(*tasks)