from aiohttp import web
from server import PromptServer
from .config_manager import config_manager
from .services.baidu import BaiduTranslateService
from .services.llm import LLMService
from .services.vlm import VisionService
from .services.model_list import get_models_from_service
import base64
import json
import traceback
import asyncio
import folder_paths
import imageio
import os
from .utils.common import (
    # 统一日志前缀（从 common.py 导入）
    PREFIX, ERROR_PREFIX, PROCESS_PREFIX,
    REQUEST_PREFIX, WARN_PREFIX,
    _ANSI_CLEAR_EOL,
    # 统一日志函数和常量
    log_prepare, TASK_TRANSLATE, TASK_EXPAND, TASK_IMAGE_CAPTION, SOURCE_FRONTEND
)
from .utils.video import extract_frame_by_index, get_video_frame_info

# 动态获取插件目录名作为路由前缀的基础
# 这样即使文件夹被重命名（例如加上 comfyui- 前缀），路由也会自动适配
NODE_DIR_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
API_PREFIX = f'/{NODE_DIR_NAME}/api'

# print(f"{PREFIX} API 路由已挂载至: {API_PREFIX}")

# 在服务器初始化时验证激活提示词
config_manager.validate_and_fix_active_prompts()
# 新增：在启动时补全模型提供商及参数
config_manager.validate_and_fix_model_params()



# 用于跟踪正在进行的异步任务
ACTIVE_TASKS = {}

# ---流式进度设置（运行时状态，实时生效无需重启）---
_streaming_progress_enabled = True

def is_streaming_progress_enabled():
    """供其他模块查询当前流式进度设置"""
    return _streaming_progress_enabled

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

# ---流式进度设置API---

@PromptServer.instance.routes.get(f'{API_PREFIX}/settings/streaming_progress')
async def get_streaming_progress_setting(request):
    """获取流式进度设置"""
    return web.json_response({"enabled": _streaming_progress_enabled})

@PromptServer.instance.routes.post(f'{API_PREFIX}/settings/streaming_progress')
async def set_streaming_progress_setting(request):
    """设置流式进度（实时生效，不需重启）"""
    global _streaming_progress_enabled
    try:
        data = await request.json()
        _streaming_progress_enabled = data.get("enabled", True)
        return web.json_response({"success": True})
    except Exception as e:
        print(f"{ERROR_PREFIX} 更新流式进度设置失败: {str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

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

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/translate')
async def get_translate_config(request):
    """获取翻译服务配置"""
    config = config_manager.get_translate_config()
    return web.json_response(config)

# --- 方案A：API Key掩码接口（安全版本）---

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/llm/masked')
async def get_llm_config_masked(request):
    """
    获取LLM配置（API Key掩码版本）
    用于前端显示，不暴露完整API Key
    """
    config = config_manager.get_llm_config_masked()
    return web.json_response(config)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/vision/masked')
async def get_vision_config_masked(request):
    """
    获取视觉模型配置（API Key掩码版本）
    用于前端显示，不暴露完整API Key
    """
    config = config_manager.get_vision_config_masked()
    return web.json_response(config)

# --- 服务商管理API接口（v2.0）---

@PromptServer.instance.routes.get(f'{API_PREFIX}/services')
async def get_services_list(request):
    """
    获取所有服务商列表
    返回所有已配置的服务商（不包含敏感信息）
    """
    try:
        services = config_manager.get_all_services()
        
        # 移除敏感信息
        safe_services = []
        for service in services:
            safe_service = service.copy()
            # 移除加密的API Key
            if 'api_key_encrypted' in safe_service:
                del safe_service['api_key_encrypted']
            # 添加掩码信息
            safe_service['has_api_key'] = bool(service.get('api_key_encrypted'))
            safe_services.append(safe_service)
        
        return web.json_response({
            "success": True,
            "services": safe_services
        })
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取服务商列表失败 | 错误:{str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/services/{{service_id}}/masked')
async def get_service_masked(request):
    """
    获取指定服务商配置（掩码版本）
    API Key为掩码，不暴露完整值
    """
    try:
        service_id = request.match_info['service_id']
        service = config_manager.get_service(service_id)
        
        if not service:
            return web.json_response({
                "success": False,
                "error": f"服务商不存在: {service_id}"
            }, status=404)
        
        # 掩码处理
        safe_service = service.copy()
        if 'api_key_encrypted' in safe_service:
            # 解密后掩码
            from .utils.common import SimpleEncryption
            api_key = SimpleEncryption.decrypt(safe_service['api_key_encrypted'])
            safe_service['api_key_masked'] = config_manager.mask_api_key(api_key)
            safe_service['api_key_exists'] = bool(api_key)
            del safe_service['api_key_encrypted']
        
        return web.json_response({
            "success": True,
            "service": safe_service
        })
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取服务商配置失败 | 错误:{str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/services')
async def create_service(request):
    """
    创建新的服务商
    请求体: {type, name, base_url, api_key, description}
    """
    try:
        data = await request.json()
        
        service_type = data.get('type')
        name = data.get('name')
        base_url = data.get('base_url', '')
        api_key = data.get('api_key', '')
        description = data.get('description', '')
        
        if not service_type or not name:
            return web.json_response({
                "success": False,
                "error": "缺少必需参数: type 和 name"
            }, status=400)
        
        service_id = config_manager.create_service(
            service_type=service_type,
            name=name,
            base_url=base_url,
            api_key=api_key,
            description=description
        )
        
        if service_id:
            print(f"{PREFIX} 成功创建服务商 | 名称:{name} | ID:{service_id}")
            return web.json_response({
                "success": True,
                "service_id": service_id
            })
        else:
            return web.json_response({
                "success": False,
                "error": "创建服务商失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 创建服务商异常 | 错误:{str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.put(f'{API_PREFIX}/services/{{service_id}}')
async def update_service_config(request):
    """
    更新服务商配置
    请求体: {name, description, base_url, api_key, auto_unload}
    注意：仅在payload包含api_key时才更新API Key
    """
    try:
        service_id = request.match_info['service_id']
        data = await request.json()
        
        # 更新服务商
        success = config_manager.update_service(service_id, **data)
        
        if success:
            print(f"{PREFIX} 成功更新服务商 | ID:{service_id}")
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "更新服务商失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 更新服务商异常 | 错误:{str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.delete(f'{API_PREFIX}/services/{{service_id}}')
async def delete_service(request):
    """
    删除服务商
    """
    try:
        service_id = request.match_info['service_id']
        
        success = config_manager.delete_service(service_id)
        
        if success:
            print(f"{PREFIX} 成功删除服务商 | ID:{service_id}")
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "删除服务商失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 删除服务商异常 | 错误:{str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/services/{{service_id}}')
async def get_service(request):
    """
    获取指定服务商的配置
    """
    try:
        service_id = request.match_info.get('service_id')
        service = config_manager.get_service(service_id)
        
        if service:
            return web.json_response({
                "success": True,
                "service": service
            })
        else:
            return web.json_response({
                "success": False,
                "error": f"服务商不存在: {service_id}"
            }, status=404)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取服务商失败: {str(e)}")
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/services/current')
async def set_current_service_api(request):
    """
    设置当前使用的服务商
    请求体: {service_type: 'llm'|'vlm'|'translate', service_id: string, model_name?: string}
    """
    try:
        data = await request.json()
        service_type = data.get('service_type')
        service_id = data.get('service_id')
        model_name = data.get('model_name')  # 可选参数
        
        # 验证参数
        if not service_type or not service_id:
            return web.json_response({
                "success": False,
                "error": "缺少必要参数: service_type 和 service_id"
            }, status=400)
        
        if service_type not in ['llm', 'vlm', 'translate']:
            return web.json_response({
                "success": False,
                "error": "service_type必须为'llm'、'vlm'或'translate'"
            }, status=400)
        
        # 调用配置管理器设置服务(现在支持model_name参数)
        success = config_manager.set_current_service(service_type, service_id, model_name)
        
        if success:
            return web.json_response({
                "success": True,
                "message": f"成功设置当前{service_type}服务"
            })
        else:
            return web.json_response({
                "success": False,
                "error": "设置服务失败"
            }, status=500)
    except Exception as e:
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

# ====================== 模型列表API ======================

@PromptServer.instance.routes.get(f'{API_PREFIX}/services/{{service_id}}/models')
async def get_service_models(request):
    """
    获取服务商的模型列表
    """
    try:
        service_id = request.match_info.get('service_id')
        
        # 获取服务商信息
        service = config_manager.get_service(service_id)
        
        if not service:
            print(f"{ERROR_PREFIX} 服务商不存在 | ID:{service_id}")
            return web.json_response({
                "success": False,
                "error": f"服务商不存在: {service_id}"
            }, status=404)
        
        base_url = service.get('base_url', '')
        api_key = service.get('api_key', '')
        service_type = service.get('type', 'openai_compatible')
        
        # 特殊处理:智谱服务强制使用 'zhipu' 类型(使用预定义列表)
        if service_id == 'zhipu':
            service_type = 'zhipu'
        
        # 获取模型列表（新格式包含success和error）
        result = get_models_from_service(base_url, api_key, service_type)
        
        # 检查是否成功
        if not result.get('success'):
            error_msg = result.get('error', '未知错误')
            print(f"{ERROR_PREFIX} 获取模型列表失败: {error_msg}")
            return web.json_response({
                "success": False,
                "error": error_msg
            }, status=400)
        
        models = result.get('models', {'llm': [], 'vlm': []})
        
        # 统计模型总数(LLM和VLM列表相同,只统计一个)
        total_count = len(models.get('llm', []))
        print(f"{PREFIX} 模型列表获取成功 | 共 {total_count} 个模型")
        
        return web.json_response({
            "success": True,
            "models": models
        })
        
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取模型列表失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.post(f'{API_PREFIX}/services/{{service_id}}/models')
async def add_model_to_service_api(request):
    """
    添加模型到服务商
    
    Request body: {model_type, model_name, temperature, top_p, max_tokens}
    """
    try:
        service_id = request.match_info.get('service_id')
        data = await request.json()
        
        model_type = data.get('model_type')
        model_name = data.get('model_name')
        temperature = data.get('temperature', 0.7)
        top_p = data.get('top_p', 0.9)
        max_tokens = data.get('max_tokens', 4096)
        
        if not model_type or not model_name:
            return web.json_response({
                "success": False,
                "error": "缺少必需参数: model_type 和 model_name"
            }, status=400)
        
        success = config_manager.add_model_to_service(
            service_id, model_type, model_name, temperature, top_p, max_tokens
        )
        
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "添加模型失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 添加模型失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.delete(f'{API_PREFIX}/services/{{service_id}}/models/{{model_type}}/{{model_name}}')
async def delete_model_from_service_api(request):
    """
    从服务商删除模型
    """
    try:
        service_id = request.match_info.get('service_id')
        model_type = request.match_info.get('model_type')
        model_name = request.match_info.get('model_name')
        
        success = config_manager.delete_model_from_service(service_id, model_type, model_name)
        
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "删除模型失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 删除模型失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.put(f'{API_PREFIX}/services/{{service_id}}/models/default')
async def set_default_model_api(request):
    """
    设置默认模型
    
    Request body: {model_type, model_name}
    """
    try:
        service_id = request.match_info.get('service_id')
        data = await request.json()
        
        model_type = data.get('model_type')
        model_name = data.get('model_name')
        
        if not model_type or not model_name:
            return web.json_response({
                "success": False,
                "error": "缺少必需参数: model_type 和 model_name"
            }, status=400)
        
        success = config_manager.set_default_model(service_id, model_type, model_name)
        
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "设置默认模型失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 设置默认模型失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.put(f'{API_PREFIX}/services/{{service_id}}/models/order')
async def update_model_order_api(request):
    """
    更新模型顺序
    
    Request body: {model_type, model_names}
    """
    try:
        service_id = request.match_info.get('service_id')
        data = await request.json()
        
        model_type = data.get('model_type')
        model_names = data.get('model_names', [])
        
        if not model_type:
            return web.json_response({
                "success": False,
                "error": "缺少必需参数: model_type"
            }, status=400)
        
        success = config_manager.update_model_order(service_id, model_type, model_names)
        
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "更新模型顺序失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 更新模型顺序失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.put(f'{API_PREFIX}/services/order')
async def update_services_order_api(request):
    """
    更新服务商顺序

    Request body: {service_ids: ['id1', 'id2', ...]}
    """
    try:
        data = await request.json()
        service_ids = data.get('service_ids', [])

        if not service_ids:
            return web.json_response({
                "success": False,
                "error": "缺少必需参数: service_ids"
            }, status=400)

        success = config_manager.update_services_order(service_ids)

        if success:
            print(f"{PREFIX} 成功更新服务商顺序 | 顺序:{', '.join(service_ids)}")
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "更新服务商顺序失败"
            }, status=500)

    except Exception as e:
        print(f"{ERROR_PREFIX} 更新服务商顺序失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


@PromptServer.instance.routes.put(f'{API_PREFIX}/services/{{service_id}}/models/parameter')
async def update_model_parameter_api(request):
    """
    更新模型参数
    
    Request body: {model_type, model_name, parameter_name, parameter_value}
    """
    try:
        service_id = request.match_info.get('service_id')
        data = await request.json()
        
        model_type = data.get('model_type')
        model_name = data.get('model_name')
        parameter_name = data.get('parameter_name')
        parameter_value = data.get('parameter_value')
        
        if not all([model_type, model_name, parameter_name, parameter_value is not None]):
            return web.json_response({
                "success": False,
                "error": "缺少必需参数"
            }, status=400)
        
        success = config_manager.update_model_parameter(
            service_id, model_type, model_name, parameter_name, parameter_value
        )
        
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({
                "success": False,
                "error": "更新模型参数失败"
            }, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 更新模型参数失败: {str(e)}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)


# ====================== 配置API ======================

def _load_ui_locale_messages(language: str):
    """加载界面本地化词典"""
    # 基础路径
    locales_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")
    
    # 尝试加载请求的语言，如果失败回退到中文
    locale_path = os.path.join(locales_dir, language, "ui.json")
    if os.path.exists(locale_path):
        normalized = language
    else:
        normalized = "zh"
        locale_path = os.path.join(locales_dir, normalized, "ui.json")
    
    try:
        with open(locale_path, "r", encoding="utf-8") as f:
            return normalized, json.load(f)
    except Exception as e:
        print(f"{ERROR_PREFIX} 无法读取语言文件 {locale_path}: {str(e)}")
        # 最后的兜底，返回空词典
        return "zh", {}

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/ui_locale/{{language}}')
async def get_ui_locale(request):
    """获取前端UI本地化词典"""
    try:
        language = request.match_info.get("language", "zh")
        normalized, messages = _load_ui_locale_messages(language)
        return web.json_response({
            "success": True,
            "language": normalized,
            "messages": messages
        })
    except Exception as e:
        print(f"{ERROR_PREFIX} UI本地化词典加载失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

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
    """获取标签配置（已废弃，tags.json 已被 CSV 系统替代）"""
    try:
        # tags.json 已废弃，返回空对象
        return web.json_response({})
    except Exception as e:
        print(f"{ERROR_PREFIX} 标签配置加载失败 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)



@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags_user')
async def get_user_tags_config(request):
    """获取用户自定义标签配置"""
    try:
        # 使用配置管理器加载用户标签
        user_tags = config_manager.load_user_tags()
        
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
        
        # 使用配置管理器保存用户标签
        success = config_manager.save_user_tags(data)
        
        if success:
            return web.json_response({"success": True})
        else:
            print(f"{ERROR_PREFIX} 用户标签配置文件更新失败")
            return web.json_response({"error": "保存失败"}, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 用户标签配置更新异常 | 错误:{str(e)}")
        return web.json_response({"error": str(e)}, status=500)

# ---CSV标签系统API---

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags_files')
async def get_tags_files(request):
    """获取tags目录下所有CSV文件列表"""
    try:
        files = config_manager.list_tags_files()
        return web.json_response({"success": True, "files": files})
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取标签文件列表失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags_csv/{{filename}}')
async def get_tags_csv(request):
    """加载指定CSV标签文件"""
    try:
        filename = request.match_info.get('filename')
        if not filename or not filename.endswith('.csv'):
            return web.json_response({"success": False, "error": "无效的文件名"}, status=400)
        
        tags_data = config_manager.load_tags_csv(filename)
        return web.json_response(
            {"success": True, "data": tags_data},
            # FIXME #81暫時處裡，防止請求被快取(但根本問題尚需優化)
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
    except Exception as e:
        print(f"{ERROR_PREFIX} 加载CSV标签文件失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/tags_csv/{{filename}}')
async def save_tags_csv(request):
    """保存标签数据到指定CSV文件"""
    try:
        filename = request.match_info.get('filename')
        if not filename or not filename.endswith('.csv'):
            return web.json_response({"success": False, "error": "无效的文件名"}, status=400)
        
        data = await request.json()
        tags_data = data.get('data', {})
        
        success = config_manager.save_tags_csv(filename, tags_data)
        if success:
            print(f"{PREFIX} CSV标签文件保存成功 | 文件:{filename}")
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "保存失败"}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 保存CSV标签文件失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/tags_selection')
async def get_tags_selection(request):
    """获取用户选择的标签文件"""
    try:
        selection = config_manager.get_tags_selection()
        return web.json_response({"success": True, "selection": selection})
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取标签选择失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/tags_selection')
async def save_tags_selection(request):
    """保存用户选择的标签文件"""
    try:
        data = await request.json()
        success = config_manager.save_tags_selection(data)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "保存失败"}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 保存标签选择失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.get(f'{API_PREFIX}/config/favorites')
async def get_favorites(request):
    """获取收藏列表"""
    try:
        favorites = config_manager.get_favorites()
        return web.json_response({"success": True, "favorites": favorites})
    except Exception as e:
        print(f"{ERROR_PREFIX} 获取收藏列表失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/favorites/add')
async def add_favorite(request):
    """添加单个收藏"""
    try:
        data = await request.json()
        tag_value = data.get('tag_value')
        tag_name = data.get('tag_name')  # 获取可选的标签名称
        category = data.get('category')  # 获取可选的分类（来源文件）
        if not tag_value:
            return web.json_response({"success": False, "error": "缺少tag_value参数"}, status=400)
        
        success = config_manager.add_favorite(tag_value, tag_name, category)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "添加失败"}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 添加收藏失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/config/favorites/remove')
async def remove_favorite(request):
    """移除单个收藏"""
    try:
        data = await request.json()
        tag_value = data.get('tag_value')
        category = data.get('category')
        if not tag_value:
            return web.json_response({"success": False, "error": "缺少tag_value参数"}, status=400)
        
        success = config_manager.remove_favorite(tag_value, category)
        if success:
            return web.json_response({"success": True})
        else:
            return web.json_response({"success": False, "error": "移除失败"}, status=500)
    except Exception as e:
        print(f"{ERROR_PREFIX} 移除收藏失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

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
            print(f"{PREFIX} 系统提示词配置更新成功 | 激活提示词: 提示词优化={expand_id}, 中文反推={vision_zh_id}, 英文反推={vision_en_id}")
            
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
                auto_unload = provider_config.get('auto_unload')

                # 更新配置，但不更新current_provider
                success = success and config_manager.update_llm_config(
                    provider=provider,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    auto_unload=auto_unload,
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
                auto_unload = provider_config.get('auto_unload')

                # 更新配置，但不更新current_provider
                success = success and config_manager.update_vision_config(
                    provider=provider,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    auto_unload=auto_unload,
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
            print(f"{WARN_PREFIX} 请求已取消 | ID:{request_id}")
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
        
        # 准备阶段日志
        # 语言显示文字映射
        lang_names = {
            "auto": "自动检测", "zh": "简体中文", "en": "英文", "zh-TW": "繁体中文", 
            "ja": "日语", "ko": "韩语", "ar": "阿拉伯语", "es": "西班牙语", 
            "fa": "波斯语", "fr": "法语", "pt-BR": "葡萄牙语(巴西)", "ru": "俄语", "tr": "土耳其语"
        }
        from_lang_name = lang_names.get(from_lang, from_lang)
        to_lang_name = lang_names.get(to_lang, to_lang)
        log_prepare(TASK_TRANSLATE, request_id, SOURCE_FRONTEND, "百度翻译", None, None, {"方向": f"{from_lang_name}→{to_lang_name}", "长度": len(text)})
        
        # 创建并注册任务
        task = asyncio.create_task(BaiduTranslateService.translate(text, from_lang, to_lang, request_id, is_auto, task_type=TASK_TRANSLATE, source=SOURCE_FRONTEND))
        ACTIVE_TASKS[request_id] = task
        
        result = await task
        
        # 服务层已输出错误日志，此处不再重复输出
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} 百度翻译任务被取消 | ID:{request_id}", flush=True)
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

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        llm_config = config_manager.get_llm_config()
        if llm_config:
            provider = llm_config.get('provider', 'ollama')
            model = llm_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            # 检查disable_thinking配置
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            # 获取规则名称
            system_prompts = config_manager.get_system_prompts()
            rule_name = "未知规则"
            if system_prompts and 'expand_prompts' in system_prompts:
                active_prompt_id = system_prompts.get('active_prompts', {}).get('expand', 'expand_default')
                if active_prompt_id in system_prompts['expand_prompts']:
                    rule_name = system_prompts['expand_prompts'][active_prompt_id].get('name', active_prompt_id)
                elif len(system_prompts['expand_prompts']) > 0:
                    # 如果激活的ID不存在,使用第一个
                    first_id = list(system_prompts['expand_prompts'].keys())[0]
                    rule_name = system_prompts['expand_prompts'][first_id].get('name', first_id)
            
            log_prepare(TASK_EXPAND, request_id, SOURCE_FRONTEND, provider_display, model_display, rule_name, {"长度": len(prompt)})

        # 创建并注册任务
        task = asyncio.create_task(LLMService.expand_prompt(prompt, request_id, task_type=TASK_EXPAND, source=SOURCE_FRONTEND))
        ACTIVE_TASKS[request_id] = task
        
        result = await task
        
        # 服务层已输出错误日志，此处不再重复输出
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} LLM提示词优化任务被取消 | ID:{request_id}", flush=True)
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} LLM提示词优化请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
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

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        prefix = AUTO_TRANSLATE_REQUEST_PREFIX if is_auto else REQUEST_PREFIX
        # 语言显示文字映射
        lang_names = {
            "auto": "自动检测", "zh": "简体中文", "en": "英文", "zh-TW": "繁体中文", 
            "ja": "日语", "ko": "韩语", "ar": "阿拉伯语", "es": "西班牙语", 
            "fa": "波斯语", "fr": "法语", "pt-BR": "葡萄牙语(巴西)", "ru": "俄语", "tr": "土耳其语"
        }
        from_lang_name = lang_names.get(from_lang, from_lang)
        to_lang_name = lang_names.get(to_lang, to_lang)
        
        # 使用独立的翻译配置
        translate_config = config_manager.get_translate_config()
        if translate_config:
            provider = translate_config.get('provider', 'baidu')
            model = translate_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            # 检查disable_thinking配置
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            log_prepare(TASK_TRANSLATE, request_id, SOURCE_FRONTEND, provider_display, model_display, None, {"方向": f"{from_lang_name}→{to_lang_name}", "长度": len(text)})

        # 创建并注册任务
        task = asyncio.create_task(LLMService.translate(
            text=text, 
            from_lang=from_lang, 
            to_lang=to_lang, 
            request_id=request_id, 
            custom_provider=provider if translate_config else None,
            custom_provider_config=translate_config,
            cancel_event=None,
            task_type=TASK_TRANSLATE,
            source=SOURCE_FRONTEND
        ))
        ACTIVE_TASKS[request_id] = task

        result = await task
        
        # 服务层已输出错误日志，此处不再重复输出
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} LLM翻译任务被取消 | ID:{request_id}", flush=True)
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

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        vision_config = config_manager.get_vision_config()
        if vision_config:
            provider = vision_config.get('provider', 'ollama')
            model = vision_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            # 检查disable_thinking配置
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            # 获取规则名称
            rule_name = "默认规则"
            if prompt_content:
                # 如果前端传了自定义提示词,尝试匹配规则名称
                system_prompts = config_manager.get_system_prompts()
                if system_prompts and 'vision_prompts' in system_prompts:
                    # 尝试从vision_prompts中匹配
                    for prompt_id, prompt_data in system_prompts['vision_prompts'].items():
                        if prompt_data.get('content') == prompt_content:
                            rule_name = prompt_data.get('name', prompt_id)
                            break
                    else:
                        # 如果没有匹配到,说明是自定义的
                        rule_name = "自定义规则"
            else:
                # 使用激活的系统提示词(需要判断语言)
                # 这里简化为获取激活的中文规则,实际应该根据提示词判断语言
                system_prompts = config_manager.get_system_prompts()
                if system_prompts:
                    active_prompts = system_prompts.get('active_prompts', {})
                    # 优先使用中文规则
                    active_prompt_id = active_prompts.get('vision_zh')
                    if active_prompt_id and 'vision_prompts' in system_prompts:
                        if active_prompt_id in system_prompts['vision_prompts']:
                            rule_name = system_prompts['vision_prompts'][active_prompt_id].get('name', active_prompt_id)
            
            log_prepare(TASK_IMAGE_CAPTION, request_id, SOURCE_FRONTEND, provider_display, model_display, rule_name)

        # 创建并注册任务，使用新的接口签名
        task = asyncio.create_task(VisionService.analyze_image(
            image_data=image_data,
            request_id=request_id,
            prompt_content=prompt_content,
            task_type=TASK_IMAGE_CAPTION,
            source=SOURCE_FRONTEND
        ))
        ACTIVE_TASKS[request_id] = task

        result = await task

        # 服务层已输出错误日志，此处不再重复输出
        return web.json_response(result)
    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} 视觉分析任务被取消 | ID:{request_id}", flush=True)
        return web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 视觉分析请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

# ---流式输出API（SSE）---

@PromptServer.instance.routes.post(f'{API_PREFIX}/vlm/analyze/stream')
async def vlm_analyze_stream(request):
    """
    视觉分析API（流式版本）
    使用 Server-Sent Events (SSE) 逐 token 推送分析结果
    """
    request_id = None
    response = None
    try:
        data = await request.json()
        image_data = data.get("image")
        request_id = data.get("request_id")
        prompt_content = data.get("prompt")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        # 创建 SSE 响应
        response = web.StreamResponse(
            status=200,
            headers={
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',  # 禁用 nginx 缓冲
            }
        )
        await response.prepare(request)

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        vision_config = config_manager.get_vision_config()
        if vision_config:
            provider = vision_config.get('provider', 'ollama')
            model = vision_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            # 获取规则名称
            rule_name = "默认规则"
            if prompt_content:
                system_prompts = config_manager.get_system_prompts()
                if system_prompts and 'vision_prompts' in system_prompts:
                    for prompt_id, prompt_data in system_prompts['vision_prompts'].items():
                        if prompt_data.get('content') == prompt_content:
                            rule_name = prompt_data.get('name', prompt_id)
                            break
                    else:
                        rule_name = "自定义规则"
            
            log_prepare(TASK_IMAGE_CAPTION, request_id, SOURCE_FRONTEND, provider_display, model_display, rule_name)

        # 用于收集完整内容
        full_content = []
        
        # 定义流式回调
        def stream_callback(chunk):
            full_content.append(chunk)
            # 将 chunk 作为 SSE 事件发送（同步版本，由调用者处理）
            return chunk

        # 创建任务
        async def run_analysis():
            return await VisionService.analyze_image(
                image_data=image_data,
                request_id=request_id,
                prompt_content=prompt_content,
                stream_callback=stream_callback,
                task_type=TASK_IMAGE_CAPTION,
                source=SOURCE_FRONTEND
            )

        task = asyncio.create_task(run_analysis())
        ACTIVE_TASKS[request_id] = task

        # 轮询并发送流式内容
        last_sent_index = 0
        while not task.done():
            # 发送新的 chunks
            while last_sent_index < len(full_content):
                chunk = full_content[last_sent_index]
                sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
                await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
                last_sent_index += 1
            await asyncio.sleep(0.05)  # 50ms 轮询间隔

        # 发送剩余的 chunks
        while last_sent_index < len(full_content):
            chunk = full_content[last_sent_index]
            sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
            await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
            last_sent_index += 1

        # 获取结果
        result = await task
        
        # 发送完成信号
        done_data = json.dumps({"done": True, "result": result}, ensure_ascii=False)
        await response.write(f"data: {done_data}\n\n".encode('utf-8'))
        
        await response.write_eof()
        return response

    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} 流式视觉分析任务被取消 | ID:{request_id}", flush=True)
        if response:
            error_data = json.dumps({"error": "请求已取消", "cancelled": True}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
        return response if response else web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 流式视觉分析请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        if response:
            error_data = json.dumps({"error": error_msg}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
            return response
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

@PromptServer.instance.routes.post(f'{API_PREFIX}/llm/expand/stream')
async def llm_expand_stream(request):
    """
    LLM扩写API（流式版本）
    使用 Server-Sent Events (SSE) 逐 token 推送扩写结果
    """
    request_id = None
    response = None
    try:
        data = await request.json()
        prompt = data.get("prompt")
        request_id = data.get("request_id")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        # 创建 SSE 响应
        response = web.StreamResponse(
            status=200,
            headers={
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            }
        )
        await response.prepare(request)

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        llm_config = config_manager.get_llm_config()
        if llm_config:
            provider = llm_config.get('provider', 'ollama')
            model = llm_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            # 获取规则名称
            system_prompts = config_manager.get_system_prompts()
            rule_name = "未知规则"
            if system_prompts and 'expand_prompts' in system_prompts:
                active_prompt_id = system_prompts.get('active_prompts', {}).get('expand', 'expand_default')
                if active_prompt_id in system_prompts['expand_prompts']:
                    rule_name = system_prompts['expand_prompts'][active_prompt_id].get('name', active_prompt_id)
                elif len(system_prompts['expand_prompts']) > 0:
                    first_id = list(system_prompts['expand_prompts'].keys())[0]
                    rule_name = system_prompts['expand_prompts'][first_id].get('name', first_id)
            
            log_prepare(TASK_EXPAND, request_id, SOURCE_FRONTEND, provider_display, model_display, rule_name, {"长度": len(prompt)})

        # 用于收集完整内容
        full_content = []
        
        # 定义流式回调
        def stream_callback(chunk):
            full_content.append(chunk)
            return chunk

        # 创建任务
        async def run_expand():
            return await LLMService.expand_prompt(
                prompt=prompt,
                request_id=request_id,
                stream_callback=stream_callback,
                task_type=TASK_EXPAND,
                source=SOURCE_FRONTEND
            )

        task = asyncio.create_task(run_expand())
        ACTIVE_TASKS[request_id] = task

        # 轮询并发送流式内容
        last_sent_index = 0
        while not task.done():
            while last_sent_index < len(full_content):
                chunk = full_content[last_sent_index]
                sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
                await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
                last_sent_index += 1
            await asyncio.sleep(0.05)

        # 发送剩余的 chunks
        while last_sent_index < len(full_content):
            chunk = full_content[last_sent_index]
            sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
            await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
            last_sent_index += 1

        # 获取结果
        result = await task
        
        # 发送完成信号
        done_data = json.dumps({"done": True, "result": result}, ensure_ascii=False)
        await response.write(f"data: {done_data}\n\n".encode('utf-8'))
        
        await response.write_eof()
        return response

    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} 流式LLM扩写任务被取消 | ID:{request_id}", flush=True)
        if response:
            error_data = json.dumps({"error": "请求已取消", "cancelled": True}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
        return response if response else web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 流式LLM扩写请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        if response:
            error_data = json.dumps({"error": error_msg}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
            return response
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

@PromptServer.instance.routes.post(f'{API_PREFIX}/llm/translate/stream')
async def llm_translate_stream(request):
    """
    LLM翻译API（流式版本）
    使用 Server-Sent Events (SSE) 逐 token 推送翻译结果
    注意：仅支持LLM翻译，百度翻译不支持流式，请使用原有接口
    """
    request_id = None
    response = None
    try:
        data = await request.json()
        text = data.get("text")
        from_lang = data.get("from", "auto")
        to_lang = data.get("to", "zh")
        request_id = data.get("request_id")

        if not request_id:
            return web.json_response({"success": False, "error": "缺少request_id"}, status=400)

        if not text or text.strip() == '':
            return web.json_response({"success": False, "error": "缺少翻译文本"}, status=400)

        # 创建 SSE 响应
        response = web.StreamResponse(
            status=200,
            headers={
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            }
        )
        await response.prepare(request)

        # 准备阶段日志
        from .services.thinking_control import build_thinking_suppression
        from .utils.common import format_model_with_thinking
        from .services.openai_base import OpenAICompatibleService
        
        # 使用翻译服务配置（而非LLM配置）
        translate_config = config_manager.get_translate_config()
        if translate_config:
            provider = translate_config.get('provider', 'ollama')
            model = translate_config.get('model', '')
            provider_display = OpenAICompatibleService.get_provider_display_name(provider)
            
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model, bool(thinking_extra))
            
            log_prepare(TASK_TRANSLATE, request_id, SOURCE_FRONTEND, provider_display, model_display, f"{from_lang}→{to_lang}", {"长度": len(text)})

        # 用于收集完整内容
        full_content = []
        
        # 定义流式回调
        def stream_callback(chunk):
            full_content.append(chunk)
            return chunk

        # 创建任务
        async def run_translate():
            return await LLMService.translate(
                text=text,
                from_lang=from_lang,
                to_lang=to_lang,
                request_id=request_id,
                stream_callback=stream_callback,
                task_type=TASK_TRANSLATE,
                source=SOURCE_FRONTEND
            )

        task = asyncio.create_task(run_translate())
        ACTIVE_TASKS[request_id] = task

        # 轮询并发送流式内容
        last_sent_index = 0
        while not task.done():
            while last_sent_index < len(full_content):
                chunk = full_content[last_sent_index]
                sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
                await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
                last_sent_index += 1
            await asyncio.sleep(0.05)

        # 发送剩余的 chunks
        while last_sent_index < len(full_content):
            chunk = full_content[last_sent_index]
            sse_data = json.dumps({"chunk": chunk}, ensure_ascii=False)
            await response.write(f"data: {sse_data}\n\n".encode('utf-8'))
            last_sent_index += 1

        # 获取结果
        result = await task
        
        # 发送完成信号
        done_data = json.dumps({"done": True, "result": result}, ensure_ascii=False)
        await response.write(f"data: {done_data}\n\n".encode('utf-8'))
        
        await response.write_eof()
        return response

    except asyncio.CancelledError:
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} 流式LLM翻译任务被取消 | ID:{request_id}", flush=True)
        if response:
            error_data = json.dumps({"error": "请求已取消", "cancelled": True}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
        return response if response else web.json_response({"success": False, "error": "请求已取消", "cancelled": True}, status=400)
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 流式LLM翻译请求异常 | 请求ID:{request_id if request_id else '未知'} | 错误:{error_msg}")
        if response:
            error_data = json.dumps({"error": error_msg}, ensure_ascii=False)
            await response.write(f"data: {error_data}\n\n".encode('utf-8'))
            await response.write_eof()
            return response
        return web.json_response({"success": False, "error": error_msg})
    finally:
        if request_id and request_id in ACTIVE_TASKS:
            del ACTIVE_TASKS[request_id]

@PromptServer.instance.routes.post(f'{API_PREFIX}/video/info')
async def get_video_info(request):
    """获取视频文件信息(FPS, 时长等)"""
    try:
        data = await request.json()
        filename = data.get("filename")
        subfolder = data.get("subfolder", "")
        type_ = data.get("type", "input")
        
        if not filename:
            return web.json_response({"success": False, "error": "缺少文件名参数"}, status=400)

        # 获取文件完整路径
        file_path = None
        
        # 1. 尝试直接作为绝对路径
        if os.path.exists(filename):
            file_path = filename
        else:
            # 2. 使用ComfyUI的路径解析
            file_path = folder_paths.get_annotated_filepath(filename)
        
        if not file_path or not os.path.exists(file_path):
            # 3. 尝试在input目录查找
            input_dir = folder_paths.get_input_directory()
            possible_path = os.path.join(input_dir, filename)
            if os.path.exists(possible_path):
                file_path = possible_path
        
        if not file_path or not os.path.exists(file_path):
            return web.json_response({"success": False, "error": "找不到视频文件"}, status=404)

        # 读取元数据
        info_result = get_video_frame_info(file_path)
        if info_result["success"]:
            return web.json_response({
                "success": True,
                "fps": info_result["original_fps"],
                "duration": info_result["duration"],
                "total_frames": info_result["original_total_frames"],
                "path": file_path
            })
        else:
            return web.json_response({"success": False, "error": f"读取视频元数据失败: {info_result.get('error')}"}, status=500)
            
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f'{API_PREFIX}/models/list')
async def get_models_list(request):
    """
    获取模型列表API
    请求参数:
    - provider: 服务提供商 (zhipu, siliconflow, 302ai, ollama, custom)
    - model_type: 模型类型 ('llm' 或 'vision')
    - recommended: 是否获取推荐列表 (可选，默认False)
    """
    try:
        data = await request.json()
        provider = data.get("provider")
        model_type = data.get("model_type", "llm")
        recommended = data.get("recommended", False)
        
        if not provider:
            return web.json_response({
                "success": False,
                "error": "缺少provider参数"
            }, status=400)
        
        # 如果请求推荐模型列表，直接返回静态列表
        if recommended:
            result = ModelListService.get_recommended_models(provider, model_type)
            return web.json_response(result)
        
        # 从配置中获取对应provider的API Key
        if model_type == 'llm':
            config = config_manager.get_llm_config()
        else:
            config = config_manager.get_vision_config()
        
        # 获取对应provider的配置
        providers_config = config.get('providers', {})
        provider_config = providers_config.get(provider, {})
        api_key = provider_config.get('api_key', '')
        base_url = provider_config.get('base_url', '')
        
        # 调用模型列表服务
        result = ModelListService.get_models(provider, api_key, model_type, base_url)
        
        return web.json_response(result)
        
    except Exception as e:
        error_msg = str(e)
        print(f"{ERROR_PREFIX} 获取模型列表异常 | 错误:{error_msg}")
        return web.json_response({
            "success": False,
            "error": error_msg
        }, status=500) 

# ---视频帧提取 API---

@PromptServer.instance.routes.post(f'{API_PREFIX}/video/frame')
async def get_video_frame(request):
    """
    获取视频指定帧的图片
    
    请求参数：
        filename: 视频文件名
        frame_index: 帧索引（基于 force_rate 后的帧序列）
        force_rate: 强制帧率（可选，0 表示原始帧率）
        type: 文件类型（input/output，默认 input）
    
    返回：
        success: 是否成功
        data: base64 编码的 JPEG 图片
        width/height: 图片尺寸
    """
    try:
        data = await request.json()
        filename = data.get("filename")
        frame_index = data.get("frame_index", 0)
        force_rate = data.get("force_rate", 0)
        type_ = data.get("type", "input")
        
        if not filename:
            return web.json_response({"success": False, "error": "缺少文件名参数"}, status=400)
        
        # 获取文件完整路径
        file_path = None
        
        # 1. 尝试直接作为绝对路径
        if os.path.exists(filename):
            file_path = filename
        else:
            # 2. 使用 ComfyUI 的路径解析
            file_path = folder_paths.get_annotated_filepath(filename)
        
        if not file_path or not os.path.exists(file_path):
            # 3. 尝试在 input 目录查找
            input_dir = folder_paths.get_input_directory()
            possible_path = os.path.join(input_dir, filename)
            if os.path.exists(possible_path):
                file_path = possible_path
        
        if not file_path or not os.path.exists(file_path):
            return web.json_response({"success": False, "error": "找不到视频文件"}, status=404)
        
        # 调用帧提取函数
        result = extract_frame_by_index(file_path, frame_index, force_rate)
        
        if result["success"]:
            return web.json_response(result)
        else:
            return web.json_response(result, status=500)
            
    except Exception as e:
        print(f"{ERROR_PREFIX} 帧提取失败 | 错误:{str(e)}")
        return web.json_response({"success": False, "error": str(e)}, status=500)
