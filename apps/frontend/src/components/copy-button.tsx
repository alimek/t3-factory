import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Icon button that copies `text`; its tooltip and a polite status report the outcome. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      // Browsers withhold the clipboard outside secure contexts, such as a plain-HTTP remote URL.
      setCopied("failed");
    }
  }
  const tip =
    copied === "copied" ? "Copied" : copied === "failed" ? "Copy unavailable here" : label;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => void copy()}
          >
            {copied === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {copied && tip}
      </span>
    </>
  );
}
