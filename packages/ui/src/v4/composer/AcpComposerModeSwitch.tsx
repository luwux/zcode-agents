import { memo } from "react";
import { BotIcon, ChevronDownIcon, LightbulbIcon, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { resolveModeOptionIcon } from "@/chat-input-toolbar/display.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { classifyAcpMode, type AcpModeInfo } from "@/lib/acpModePresentation.js";

function iconFor(mode: AcpModeInfo): LucideIcon {
  const category = classifyAcpMode(mode);
  switch (category) {
    case "plan":
      return LightbulbIcon;
    case "autoReview":
      return BotIcon;
    case "build":
    case "edit":
    case "yolo":
      return resolveModeOptionIcon(category);
    case "custom":
      return resolveModeOptionIcon(mode.id);
  }
}

/**
 * ACP 会话模式选择器，外观与原生 CodeZ 模式选择器一致（图标、两行说明、完全访问的警示色）；
 * 名称、说明与顺序保持 Agent 原样。模式集合与切换由 Agent 决定
 * （草稿写入 acpModeId，已有会话发 switchModelConfig）。
 */
function AcpComposerModeSwitchImpl({
  modes,
  selectedMode,
  disabled,
  onSelect,
}: {
  modes: readonly AcpModeInfo[];
  selectedMode: string;
  disabled: boolean;
  onSelect: (modeId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = modes.find((mode) => mode.id === selectedMode);
  const title = intl.formatMessage({
    id: modes.length ? "chat.toolbar.mode.label" : "chat.toolbar.acpMode.unavailable",
  });
  const SelectedIcon = selected ? iconFor(selected) : resolveModeOptionIcon("build");
  return (
    <DropdownMenu>
      <ControlHintTooltip title={title}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || !modes.length}
            aria-label={title}
            data-composer-collapse-priority="1"
            data-testid="v4-composer-acp-mode"
            data-acp-mode-id={selected?.id ?? ""}
            className={cn(
              "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              selected !== undefined &&
                classifyAcpMode(selected) === "yolo" &&
                "text-warning hover:text-warning",
            )}
          >
            <SelectedIcon className="size-4" />
            <span className="inline group-data-[composer-compact=true]/mode:hidden">
              {selected?.name ?? intl.formatMessage({ id: "chat.toolbar.acpMode.placeholder" })}
            </span>
            <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent side="top" sideOffset={4} className="w-64">
        <DropdownMenuRadioGroup value={selectedMode} onValueChange={onSelect}>
          {modes.map((mode) => {
            const Icon = iconFor(mode);
            return (
              <DropdownMenuRadioItem
                key={mode.id}
                value={mode.id}
                data-acp-mode-id={mode.id}
                data-acp-mode-category={classifyAcpMode(mode)}
                className="min-h-13 items-start gap-3 py-2"
              >
                <Icon className="mt-0.5 size-4.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{mode.name}</span>
                  {mode.description ? (
                    <span className="text-ui-sm text-foreground-subtle">{mode.description}</span>
                  ) : null}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const AcpComposerModeSwitch = memo(AcpComposerModeSwitchImpl);
