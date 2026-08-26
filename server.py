from aiohttp import web
from server import PromptServer
from .config_manager import config_manager
from .services.baidu import BaiduTranslateService
from .services.llm import LLMService
from .services.vlm import VisionService
from .services.history_store import load_history, save_history
import base64
import json
import traceback
import asyncio

# 定义颜色常量
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
RESET = "\033[0m"

# 统一日志前缀（按阶段上色）
# 绿色：结果阶段
PREFIX = f"{GREEN}[✨PromptAssistant]{RESET}"
AUTO_TRANSLATE_PREFIX = f"{GREEN}[✨PromptAssistant-自动翻译]{RESET}"
# 红色：错误
ERROR_PREFIX = f"{RED}[✨PromptAssistant-错误]{RESET}"
# 黄色：过程阶段（创建客户端/调用API等）
PROCESS_PREFIX = f"{YELLOW}[✨PromptAssistant]{RESET}"
# 蓝色：发起请求阶段
REQUEST_PREFIX = f"{BLUE}[✨PromptAssistant]{RESET}"
# 黄色：告警保持不变
WARN_PREFIX = f"{YELLOW}[✨PromptAssistant-警告]{RESET}"
# 蓝色：自动翻译的“请求阶段”前缀（仅用于请求日志着色）
AUTO_TRANSLATE_REQUEST_PREFIX = f"{BLUE}[✨PromptAssistant-自动翻译]{RESET}"

# 定义路由前缀，确保与前端请求匹配
API_PREFIX = '/prompt_assistant/api'

# 在服务器初始化时验证激活提示词
# print(f"{PREFIX} 正在验证激活提示词配置...")
config_manager.validate_and_fix_active_prompts()
# 新增：在启动时补全模型提供商及参数
config_manager.validate_and_fix_model_params()



# 用于跟踪正在进行的异步任务
ACTIVE_TASKS = {}

# 不再使用RouteTableDef
# routes = web.RouteTableDef()

def get_result_text(result):
    """
    智能提取接口返回中的文本内容，用于字符统计。
    优先级：data.translated > data.expanded > data.description > data.result > data.text > result > data（str）
    """
    if not isinstance(result, dict):
        return str(result) if result is not None else ''
    data = result.get('data')
    if isinstance(data, dict):
        for key in ['translated', 'expanded', 'description', 'result', 'text']:
            if key in data and isinstance(data[key], str):
                return data[key]
    if isinstance(data, str):
        return data
    if 'result' in result and isinstance(result['result'], str):
        return result['result']
    if 'text' in result and isinstance(result['text'], str):
        return result['text']
    return ''

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/baidu_translate')
async def get_baidu_translate_config(request):
    """获取百度翻译配置"""
    config = config_manager.get_baidu_translate_config()
    return web.json_response(config)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/llm')
async def get_llm_config(request):
    """获取LLM配置"""
    config = config_manager.get_llm_config()
    return web.json_response(config)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/vision')
async def get_vision_config(request):
    """获取视觉模型配置"""
    config = config_manager.get_vision_config()
    return web.json_response(config)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/system_prompts')
async def get_system_prompts_config(request):
    """获取系统提示词配置"""
    config = config_manager.get_system_prompts()
    return web.json_response(config)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/default_system_prompts')
async def get_default_system_prompts_config(request):
    """获取默认系统提示词配置"""
    default_prompts = config_manager.default_system_prompts
    return web.json_response(default_prompts)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags')
async def get_tags_config(request):
    """获取标签配置"""
    try:
        import os
        import json
        
        # 获取标签配置文件路径
        tags_file_path = os.path.join(os.path.dirname(__file__), "config", "tags.json")
        
        # 检查文件是否存在
        if not os.path.exists(tags_file_path):
            print(f"{ERROR_PREFIX} 标签配置文件不存在 | 路径:{tags_file_path}")
            return web.json_response({"error": "标签配置文件不存在"}, status=404)
        
        # 读取文件内容
        with open(tags_file_path, "r", encoding="utf-8") as f:
            tags_data = json.load(f)
            
        # print(f"{PREFIX} 标签配置文件加载成功")
        return web.json_response(tags_data)
    except Exception as e:
        print(f"{ERROR_PREFIX} 标签配置加载失败 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags_user')
async def get_user_tags_config(request):
    """获取用户自定义标签配置"""
    try:
        # 使用配置管理器加载用户标签
        user_tags = config_manager.load_user_tags()
        
        # print(f"{PREFIX} 用户标签配置文件加载成功")
        return web.json_response(user_tags)
    except Exception as e:
        print(f"{ERROR_PREFIX} 用户标签配置加载失败 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/tags_user')
async def update_user_tags_config(request):
    """更新用户自定义标签配置"""
    try:
        data = await request.json()
        
        # 检查数据结构是否正确
        if not isinstance(data, dict):
            print(f"{ERROR_PREFIX} 用户标签配置更新失败 | 错误:参数格式错误")
            return web.json_response({"error": "参数格式错误"}, status=400)
        
        # 保存用户标签数据
        import os
        import json
        
        # 获取用户标签配置文件路径
        tags_user_file_path = os.path.join(os.path.dirname(__file__), "config", "tags_user.json")
        
        # 保存数据到文件
        with open(tags_user_file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        # print(f"{PREFIX} 用户标签配置文件更新成功")
        return web.json_response({"success": True})
    except Exception as e:
        print(f"{ERROR_PREFIX} 用户标签配置更新异常 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/baidu_translate')
async def update_baidu_translate_config(request):
    """更新百度翻译配置"""
    try:
        data = await request.json()
        app_id = data.get('app_id')
        secret_key = data.get('secret_key')
        
        # 获取当前配置
        current_config = config_manager.get_baidu_translate_config()
        
        # 如果提供了 app_id，则更新 app_id
        if app_id is not None:
            current_config['app_id'] = app_id
            
        # 如果提供了 secret_key，则更新 secret_key
        if secret_key is not None:
            current_config['secret_key'] = secret_key
            
        # 更新配置
        success = config_manager.update_baidu_translate_config(
            current_config['app_id'],
            current_config['secret_key']
        )
        
        if success:
            return web.json_response({'message': '配置已更新'})
        else:
            print(f"{ERROR_PREFIX} 百度翻译配置更新失败")
            return web.json_response({'error': '配置更新失败'}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 百度翻译配置更新异常 | 错误:{str(e)}")
        return web.json_response({'error': str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/system_prompts')
async def update_system_prompts_config(request):
    """更新系统提示词配置"""
    try:
        data = await request.json()
        
        # 检查数据结构是否正确
        if not isinstance(data, dict):
            print(f"{ERROR_PREFIX} 系统提示词配置更新失败 | 错误:参数格式错误")
            return web.json_response({'error': '参数格式错误'}, status=400)
            
        # 前端会直接发送包含 active_prompts 的完整配置，后端只需验证并保存
        if 'active_prompts' not in data:
            print(f"{WARN_PREFIX} 系统提示词配置更新警告 | 错误:缺少 active_prompts，尝试从现有配置恢复")
            # 即使缺少，也尝试从当前配置中恢复，以增强健壮性
            current_config = config_manager.get_system_prompts()
            data['active_prompts'] = current_config.get('active_prompts', {
                "expand": None, "vision_zh": None, "vision_en": None
            })

        # 将 active_prompts 分离出来单独处理
        active_prompts_to_update = data.pop('active_prompts', None)
        
        # 清理提示词数据中可能存在的isActive标志（以防万一）
        for prompt_type in ['expand_prompts', 'vision_prompts']:
            if prompt_type in data:
                for prompt_id, prompt_data in data[prompt_type].items():
                    if isinstance(prompt_data, dict) and 'isActive' in prompt_data:
                        del prompt_data['isActive']
        
        # 更新提示词定义
        success = config_manager.update_system_prompts(data)
        
        # 如果有 active_prompts，则更新它们
        if active_prompts_to_update:
            success = success and config_manager.update_active_prompts(active_prompts_to_update)
        
        if success:
            active_prompts = active_prompts_to_update or {}
            expand_id = active_prompts.get('expand', '无')
            vision_zh_id = active_prompts.get('vision_zh', '无')
            vision_en_id = active_prompts.get('vision_en', '无')
            print(f"{PREFIX} 系统提示词配置更新成功 | 激活提示词: 扩写={expand_id}, 中文反推={vision_zh_id}, 英文反推={vision_en_id}")
            
            # 在更新配置后验证激活提示词
            print(f"{PREFIX} 正在验证更新后的激活提示词配置...")
            config_manager.validate_and_fix_active_prompts()
            
            return web.json_response({'success': True})
        else:
            print(f"{ERROR_PREFIX} 系统提示词配置更新失败")
            return web.json_response({'error': '配置更新失败'}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 系统提示词配置更新异常 | 错误:{str(e)}")
        return web.json_response({'error': str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/active_prompt')
async def update_active_prompt_config(request):
    """更新单个激活的提示词配置"""
    try:
        data = await request.json()
        prompt_type = data.get('type')
        prompt_id = data.get('prompt_id')
        
        if not prompt_type or not prompt_id:
            return web.json_response({'error': '缺少参数 type 或 prompt_id'}, status=400)
        
        success = config_manager.update_active_prompt(prompt_type, prompt_id)
        
        if success:
            print(f"{PREFIX} 激活的提示词已更新 | 类型:{prompt_type} | ID:{prompt_id}")
            
            # 在更新单个激活提示词后验证配置
            print(f"{PREFIX} 正在验证更新后的激活提示词配置...")
            config_manager.validate_and_fix_active_prompts()
            
            return web.json_response({'success': True})
        else:
            print(f"{ERROR_PREFIX} 激活的提示词更新失败")
            return web.json_response({'error': '配置更新失败'}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 激活的提示词更新异常 | 错误:{str(e)}")
        return web.json_response({'error': str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/llm')
async def update_llm_config(request):
    """更新LLM配置"""
    try:
        data = await request.json()
        current_provider = data.get('current_provider')
        providers = data.get('providers', {})
        
        # 确保至少有一个参数提供
        if not current_provider and not providers:
            print(f"{ERROR_PREFIX} LLM配置更新失败 | 错误:参数不能全为空")
            return web.json_response({'error': '参数不能全为空'}, status=400)
            
        success = True
        
        # 先更新各提供商的配置
        if providers:
            # 逐个更新各提供商的配置
            for provider, provider_config in providers.items():
                if provider not in ['zhipu', 'siliconflow', '302ai', 'ollama', 'custom']:
                    continue
                    
                model = provider_config.get('model')
                api_key = provider_config.get('api_key')
                base_url = provider_config.get('base_url')
                temperature = provider_config.get('temperature')
                max_tokens = provider_config.get('max_tokens')
                top_p = provider_config.get('top_p')

                # 更新配置，但不更新current_provider
                success = success and config_manager.update_llm_config(
                    provider=provider,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    update_current=False
                )
                
        # 最后更新当前提供商
        if current_provider:
            success = success and config_manager.update_llm_config(
                provider=current_provider,
                update_current=True
            )
        
        if success:
            print(f"{PREFIX} LLM配置更新成功")
            return web.json_response({'success': True})
        else:
            print(f"{ERROR_PREFIX} LLM配置更新失败")
            return web.json_response({'error': '配置更新失败'}, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} LLM配置更新异常 | 错误:{str(e)}")
        return web.json_response({'error': str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/vision')
async def update_vision_config(request):
    """更新视觉模型配置"""
    try:
        data = await request.json()
        current_provider = data.get('current_provider')
        providers = data.get('providers', {})
        
        # 确保至少有一个参数提供
        if not current_provider and not providers:
            print(f"{ERROR_PREFIX} 视觉模型配置更新失败 | 错误:参数不能全为空")
            return web.json_response({'error': '参数不能全为空'}, status=400)
            
        success = True
        
        # 先更新各提供商的配置
        if providers:
            # 逐个更新各提供商的配置
            for provider, provider_config in providers.items():
                if provider not in ['zhipu', 'siliconflow', '302ai', 'ollama', 'custom']:
                    continue
                    
                model = provider_config.get('model')
                api_key = provider_config.get('api_key')
                base_url = provider_config.get('base_url')
                temperature = provider_config.get('temperature')
                max_tokens = provider_config.get('max_tokens')
                top_p = provider_config.get('top_p')

                # 更新配置，但不更新current_provider
                success = success and config_manager.update_vision_config(
                    provider=provider,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    update_current=False
                )
                
        # 最后更新当前提供商
        if current_provider:
            success = success and config_manager.update_vision_config(
                provider=current_provider,
                update_current=True
            )
        
        if success:
            print(f"{PREFIX} 视觉模型配置更新成功")
            return web.json_response({'success': True})
        else:
            print(f"{ERROR_PREFIX} 视觉模型配置更新失败")
            return web.json_response({'error': '配置更新失败'}, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 视觉模型配置更新异常 | 错误:{str(e)}")
        return web.json_response({'error': str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/request/cancel')
async def cancel_request(request):
    """取消一个正在进行的异步请求"""
    try:
        data = await request.json()
        request_id = data.get("request_id")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        task = ACTIVE_TASKS.get(request_id)
        if task and not task.done():
            task.cancel()
            # 从字典中移除已取消的任务
            del ACTIVE_TASKS[request_id]
            print(f"{PREFIX} 请求已取消 | ID:{request_id}")
            return web.json_response({"success": True, "message": "请求已取消"})
        else:
            return web.json_response({"success": False, "error": "未找到活动任务或任务已完成"}, status=404)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 取消请求时发生异常 | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg}, status=500)

# 新增API路由

@PromptServer.instance.routes.post(f'{API_PREFIX}/baidu/translate')
async def baidu_translate(request):
    """
    百度翻译API
    注意：所有的格式处理（包括序号"1."格式保护等）均由前端的promptFormatter.js负责，
    后端只负责原始文本的翻译，不进行格式预处理或后处理。
    """
    request_id = None
    try:
        data = await request.json()
        text = data.get("text")
        from_lang = data.get("from", "auto")
        to_lang = data.get("to", "zh")
        request_id = data.get("request_id")
        is_auto = data.get("is_auto", False)

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)
        
        # 创建并注册任务
        task = asyncio.create_task(BaiduTranslateService.translate(text, from_lang, to_lang, request_id, is_auto))
        ACTIVE_TASKS[request_id] = task
        
        result = await task
        
        # 如果发生错误，输出详细错误信息
        if not result.get('success'):
            if not result.get('cancelled', False):
                error_msg = result.get('error', '未知错误')
                print(f"{ERROR_PREFIX} 百度翻译请求失败 | 请求ID:{request_id} | 错误:{error_msg}")
            
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"{PREFIX} 百度翻译任务被取消 | ID:{request_id}")
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 百度翻译请求异常 | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

@PromptServer.instance.routes.post(f'{API_PREFIX}/llm/expand')
async def llm_expand(request):
    """LLM扩写API"""
    request_id = None
    try:
        data = await request.json()
        prompt = data.get("prompt")
        request_id = data.get("request_id")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        # 创建并注册任务
        task = asyncio.create_task(LLMService.expand_prompt(prompt, request_id))
        ACTIVE_TASKS[request_id] = task
        
        result = await task
        
        # 如果发生错误，输出详细错误信息
        if not result.get('success'):
            # 检查是否是用户取消
            if not result.get('cancelled', False):
                error_msg = result.get('error', '未知错误')
                print(f"{ERROR_PREFIX} LLM扩写请求失败 | 请求ID:{request_id} | 错误:{error_msg}")
        
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"{PREFIX} LLM扩写任务被取消 | ID:{request_id}")
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} LLM扩写请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]


@PromptServer.instance.routes.post(f'{API_PREFIX}/llm/translate')
async def llm_translate(request):
    """LLM翻译API"""
    request_id = None
    try:
        data = await request.json()
        text = data.get("text")
        from_lang = data.get("from", "auto")
        to_lang = data.get("to", "zh")
        request_id = data.get("request_id")
        is_auto = data.get("is_auto", False)
        
        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        # 创建并注册任务
        task = asyncio.create_task(LLMService.translate(text, from_lang, to_lang, request_id, is_auto))
        ACTIVE_TASKS[request_id] = task

        result = await task
        
        # 如果发生错误，输出详细错误信息
        if not result.get('success') and not result.get('cancelled', False):
            error_msg = result.get('error', '未知错误')
            print(f"{ERROR_PREFIX} LLM翻译请求失败 | 请求ID:{request_id} | 错误:{error_msg}")
            
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"{PREFIX} LLM翻译任务被取消 | ID:{request_id}")
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} LLM翻译请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

@PromptServer.instance.routes.post(f'{API_PREFIX}/vlm/analyze')
async def vlm_analyze(request):
    """视觉分析API"""
    request_id = None
    try:
        data = await request.json()
        image_data = data.get("image")
        request_id = data.get("request_id")
        # 从请求中获取提示词内容，这是关键的修复
        prompt_content = data.get("prompt")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        # 创建并注册任务，使用新的接口签名
        task = asyncio.create_task(VisionService.analyze_image(
            image_data=image_data,
            request_id=request_id,
            prompt_content=prompt_content
        ))
        ACTIVE_TASKS[request_id] = task

        result = await task

        # 如果发生错误，输出详细错误信息
        if not result.get('success'):
            if not result.get('cancelled', False):
                error_msg = result.get('error', '未知错误')
                print(f"{ERROR_PREFIX} 视觉分析请求失败 | 请求ID:{request_id} | 错误:{error_msg}")

        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"{PREFIX} 视觉分析任务被取消 | ID:{request_id}")
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 视觉分析请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]


# ============================ 历史记录持久化 ============================
# 历史记录由前端 localStorage 迁移到服务端 JSON 文件持久化（config/history_cache.json），
# 避免浏览器清理缓存或插件异常导致历史丢失。
# 前端每次变更后整体推送全量数组（与 HistoryCacheService.saveAllHistory 语义一致），
# 服务端负责校验、限长与原子写入。

@PromptServer.instance.routes.get(f'{API_PREFIX}/history')
async def get_history_store(request):
    """获取服务端持久化的历史记录"""
    try:
        return web.json_response({"data": load_history()})
    except Exception as e:
        print(f"{ERROR_PREFIX} 历史记录读取失败 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post(f'{API_PREFIX}/history')
async def post_history_store(request):
    """整体覆盖保存历史记录"""
    try:
        data = await request.json()
        payload = data.get("data", [])
        count = save_history(payload)
        return web.json_response({"success": True, "count": count})
    except Exception as e:
        print(f"{ERROR_PREFIX} 历史记录保存失败 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500) 