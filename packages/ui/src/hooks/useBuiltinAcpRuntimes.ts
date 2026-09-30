import { useEffect, useRef, useState } from "react";
import type {
  BuiltinRuntimeAuthChange,
  BuiltinRuntimeCatalogView,
  IZCodeAgentService,
} from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

// 目录是 Host 代码常量：同一个服务连接只读取一次。
const catalogs = new WeakMap<IZCodeAgentService, Promise<BuiltinRuntimeCatalogView>>();

function loadCatalog(service: IZCodeAgentService): Promise<BuiltinRuntimeCatalogView> {
  let pending = catalogs.get(service);
  if (!pending) {
    pending = service.listBuiltinRuntimeCatalog();
    catalogs.set(service, pending);
    // 失败不缓存，下次挂载时重试。
    pending.catch(() => catalogs.delete(service));
  }
  return pending;
}

/** 内置 ACP Runtime 的认证方式、Provider 预设与模型字段（设置页表单使用，不在 Renderer 复制预设表）。 */
export function useBuiltinAcpRuntimeCatalog(): {
  catalog: BuiltinRuntimeCatalogView | null;
  error: string | null;
} {
  const { zcodeAgentService } = useServices();
  const [state, setState] = useState<{
    catalog: BuiltinRuntimeCatalogView | null;
    error: string | null;
  }>({ catalog: null, error: null });
  useEffect(() => {
    let cancelled = false;
    loadCatalog(zcodeAgentService).then(
      (catalog) => {
        if (!cancelled) setState({ catalog, error: null });
      },
      (error: unknown) => {
        logger.warn("[BuiltinAcpRuntime] 读取内置 Runtime 目录失败", error);
        if (!cancelled)
          setState({
            catalog: null,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [zcodeAgentService]);
  return state;
}

/**
 * Host 认证状态变化（登录中 / 已登录 / 需要登录）。事件只是重新读取 listAgentRuntimes 的触发信号，
 * 不携带消息或秘密；状态的唯一所有者是 Host 的 AcpAuthStateStore。
 */
export function useAgentRuntimeAuthChanges(listener: (change: BuiltinRuntimeAuthChange) => void) {
  const { zcodeAgentService } = useServices();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => {
    if (typeof zcodeAgentService.onDynamicAgentRuntimeAuthChange !== "function") return;
    try {
      const subscription = zcodeAgentService.onDynamicAgentRuntimeAuthChange()((change) =>
        listenerRef.current(change),
      );
      return () => subscription.dispose();
    } catch (error) {
      logger.warn("[BuiltinAcpRuntime] 订阅认证状态变化失败", error);
      return undefined;
    }
  }, [zcodeAgentService]);
}
