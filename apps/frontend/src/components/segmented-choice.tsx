import { RadioGroup } from "radix-ui";
import { cn } from "@/lib/utils";

/** A short exclusive choice shown as side-by-side segments, with radio semantics. */
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
      className="flex gap-2"
    >
      {options.map(([option, title]) => (
        <RadioGroup.Item
          key={option}
          value={option}
          className={cn(
            "h-8 rounded-md border bg-muted px-3 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
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
