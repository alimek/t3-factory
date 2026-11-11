import * as React from "react";
import { AlertDialog as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Button } from "./button";

function AlertDialog(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root {...props} />;
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <Primitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border-strong bg-card p-6 shadow-panel duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:max-w-lg",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title className={cn("text-lg leading-none font-semibold", className)} {...props} />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
  );
}

function AlertDialogCancel(props: React.ComponentProps<typeof Primitive.Cancel>) {
  return (
    <Button variant="outline" asChild>
      <Primitive.Cancel {...props} />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
};
