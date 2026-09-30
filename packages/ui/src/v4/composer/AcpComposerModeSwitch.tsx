import { memo } from "react";
import { BotIcon, ChevronDownIcon, LightbulbIcon, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { resolveModeOptionIcon } from "@/chat-input-toolbar/display.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  presentAcpModes,
  type AcpModeCategory,
  type AcpModeInfo,
  type AcpModePresentation,
} from "@/lib/acpModePresentation.js";

const CATEGORY_MESSAGES: Record<
  Exclude<AcpModeCategory, "custom">,
  { label: string; description: string }
> = {
  plan: { label: "mode.label.glm.plan", description: "mode.description.glm.plan" },
  build: { label: "mode.label.glm.build", description: "mode.description.glm.build" },
  edit: { label: "mode.label.glm.edit", description: "mode.description.glm.edit" },
  autoReview: {
    label: "mode.label.acp.autoReview",
    description: "mode.description.acp.autoReview",
  },
  yolo: { label: "mode.label.glm.yolo", description: "mode.description.glm.yolo" },
};

function iconFor(entry: AcpModePresentation): LucideIcon {
  switch (entry.category) {
    case "plan":
      return LightbulbIcon;
    case "autoReview":
      return BotIcon;
    case "build":
    case "edit":
    case "yolo":
      return resolveModeOptionIcon(entry.category);
    case "custom":
      return resolveModeOptionIcon(entry.mode.id);
  }
}

/**
 * ACP 会话模式选择器，外观与原生 CodeZ 模式选择器一致：同样的图标、两行说明与完全访问的警示色。
 * 模式集合与切换仍由 Agent 决定（草稿写入 acpModeId，已有会话发 switchModelConfig）。
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
  const entries = presentAcpModes(modes);
  const label = (entry: AcpModePresentation) =>
    entry.useAgentText || entry.category === "custom"
      ? entry.mode.name
      : intl.formatMessage({ id: CATEGORY_MESSAGES[entry.category].label });
  const description = (entry: AcpModePresentation) =>
    entry.useAgentText || entry.category === "custom"
      ? entry.mode.description
      : intl.formatMessage({ id: CATEGORY_MESSAGES[entry.category].description });
  const selected = entries.find((entry) => entry.mode.id === selectedMode);
  const title = intl.formatMessage({
    id: modes.length ? "chat.toolbar.mode.label" : "chat.toolbar.acpMode.unavailable",
  });
  const SelectedIcon = selected ? iconFor(selected) : resolveModeOptionIcon("build");
  const planEntries = entries.filter((entry) => entry.category === "plan");
  const otherEntries = entries.filter((entry) => entry.category !== "plan");
  const renderItem = (entry: AcpModePresentation) => {
    const Icon = iconFor(entry);
    const text = description(entry);
    return (
      <DropdownMenuRadioItem
        key={entry.mode.id}
        value={entry.mode.id}
        data-acp-mode-id={entry.mode.id}
        data-acp-mode-category={entry.category}
        className="min-h-13 items-start gap-3 py-2"
      >
        <Icon className="mt-0.5 size-4.5 shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{label(entry)}</span>
          {text ? <span className="text-ui-sm text-foreground-subtle">{text}</span> : null}
        </span>
      </DropdownMenuRadioItem>
    );
  };
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
            data-acp-mode-id={selected?.mode.id ?? ""}
            className={cn(
              "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              selected?.category === "yolo" && "text-warning hover:text-warning",
            )}
          >
            <SelectedIcon className="size-4" />
            <span className="inline group-data-[composer-compact=true]/mode:hidden">
              {selected
                ? label(selected)
                : intl.formatMessage({ id: "chat.toolbar.acpMode.placeholder" })}
            </span>
            <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent side="top" sideOffset={4} className="w-64">
        <DropdownMenuRadioGroup value={selectedMode} onValueChange={onSelect}>
          {planEntries.map(renderItem)}
          {planEntries.length && otherEntries.length ? <DropdownMenuSeparator /> : null}
          {otherEntries.map(renderItem)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const AcpComposerModeSwitch = memo(AcpComposerModeSwitchImpl);
