"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import {
  getAvailableModels,
  setModel,
  type ModelInfo,
} from "@/lib/gateway";

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6",
  "anthropic/claude-opus-4-6": "Claude Opus 4.6",
  "google/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "openai/gpt-5.2": "ChatGPT 5.2",
  "minimax/minimax-m2.5": "MiniMax M2.5",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
};

export const MODEL_OUTPUT_PRICES: Record<string, string> = {
  "anthropic/claude-sonnet-4-6": "$15/M",
  "anthropic/claude-opus-4-6": "$25/M",
  "google/gemini-3.1-pro-preview": "$12/M",
  "openai/gpt-5.2": "$14/M",
  "minimax/minimax-m2.5": "$1.20/M",
  "moonshotai/kimi-k2.5": "$2.20/M",
};

export function ModelPicker({
  onModelChange,
}: {
  onModelChange?: (modelId: string, displayName: string) => void;
} = {}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!gatewayUrl) return;
      const result = await getAvailableModels(gatewayUrl, session.access_token);
      if (result) {
        setModels(result.models);
        setCurrentModel(result.current);
      }
    })();
  }, [supabase]);

  const handleModelChange = useCallback(
    async (newModel: string) => {
      if (newModel === currentModel || isLoading) return;
      setIsLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
        if (!gatewayUrl) return;
        await setModel(gatewayUrl, session.access_token, newModel);
        setCurrentModel(newModel);
        onModelChange?.(newModel, MODEL_DISPLAY_NAMES[newModel] ?? newModel);
      } finally {
        setIsLoading(false);
      }
    },
    [currentModel, isLoading, supabase, onModelChange]
  );

  if (models.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
        >
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          {MODEL_DISPLAY_NAMES[currentModel] ?? currentModel}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {models.map((m) => (
          <DropdownMenuItem
            key={m.id}
            disabled={!m.allowed}
            onClick={() => handleModelChange(m.id)}
          >
            <span>{MODEL_DISPLAY_NAMES[m.id] ?? m.name}</span>
            <span className="ml-auto flex items-center gap-2">
              {MODEL_OUTPUT_PRICES[m.id] && (
                <span className="text-[10px] text-muted-foreground">{MODEL_OUTPUT_PRICES[m.id]}</span>
              )}
              {m.id === currentModel && (
                <Check className="h-3.5 w-3.5" />
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
