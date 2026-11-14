import { RadioGroup } from "radix-ui";
import { cn } from "@/lib/utils";

/** Figma Settings v2/Segmented: a short exclusive choice in one bordered track, with radio semantics. */
export function SegmentedChoice<Value extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: Value;
  options: readonly (readonly [Value, string])[];
  onChange: (value: Value) => void;
}) {
  return (
    <RadioGroup.Root
      aria-labelledby={labelledBy}
      value={value}
      onValueChange={(next) => {
        const option = options.find(([candidate]) => candidate === next);
        if (option) onChange(option[0]);
      }}
      className="flex w-fit gap-0.5 rounded-md border bg-background p-0.5"
    >
      {options.map(([option, title]) => (
        <RadioGroup.Item
          key={option}
          value={option}
          className={cn(
            "h-6.5 rounded-sm px-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "data-[state=checked]:bg-sidebar-accent data-[state=checked]:text-foreground",
            // Forced colors drop the fill; system highlight colors keep the selection visible.
            "forced-colors:data-[state=checked]:bg-[Highlight] forced-colors:data-[state=checked]:text-[HighlightText] forced-colors:data-[state=checked]:forced-color-adjust-none",
          )}
        >
          {title}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
