import { useCallback, useEffect, useRef } from "react";
import type { AgentRuntimeInstallStatus, SaveBuiltinRuntimeConfigInput } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import {
  configFromStatus,
  isBuiltinAcpStatus,
  type BuiltinAcpConfig,
  type BuiltinAcpStatus,
} from "./builtinAcpConfig.js";

/**
 * 串行写入一个内置 ACP 配置。每次写入都以 Host 最近返回的已保存配置为基线生成完整配置：
 * 快速连续的操作（如依次开关两个模型）不会用过期基线互相覆盖。Host 仍是唯一所有者，
 * 这里只排队本页面自己的写入，不保存第二份配置事实。
 */
export function useBuiltinAcpConfigWriter({
  status,
  onStatuses,
}: {
  status: BuiltinAcpStatus;
  onStatuses: (statuses: AgentRuntimeInstallStatus[]) => void;
}) {
  const { zcodeAgentService } = useServices();
  const baseRef = useRef<BuiltinAcpConfig>(configFromStatus(status));
  const pendingRef = useRef(0);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const onStatusesRef = useRef(onStatuses);
  onStatusesRef.current = onStatuses;

  // 外部刷新（认证事件、手动刷新）带来新状态时同步基线；有写入进行中时以写入结果为准。
  useEffect(() => {
    if (pendingRef.current === 0) baseRef.current = configFromStatus(status);
  }, [status]);

  const write = useCallback(
    (build: (config: BuiltinAcpConfig) => SaveBuiltinRuntimeConfigInput): Promise<void> => {
      pendingRef.current += 1;
      const run = chainRef.current.then(async () => {
        const input = build(baseRef.current);
        const statuses = await zcodeAgentService.saveAgentRuntimeConfig(input);
        const saved = statuses.find((candidate) => candidate.id === input.id);
        if (isBuiltinAcpStatus(saved)) baseRef.current = configFromStatus(saved);
        onStatusesRef.current(statuses);
      });
      chainRef.current = run.catch(() => undefined);
      return run.finally(() => {
        pendingRef.current -= 1;
      });
    },
    [zcodeAgentService],
  );

  return { write, current: () => baseRef.current };
}
