/**
 * spawn → initialize → session/new|load 的并发闸门。Codex app-server 同一 CODEX_HOME 并发初始化会竞争
 * home 目录（Lody 同样限制为 2）；prompt 阶段不经过闸门。
 */
export class AcpStartupGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Startup gate limit must be >= 1");
  }

  get pending(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await operation();
    } finally {
      // 释放的名额直接交给队首等待者，active 不回落，避免新来者插队。
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export const acpStartupGate = new AcpStartupGate(2);
