'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SWITCHABLE_MODELS = [
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro' },
  { id: 'openai/gpt-5.2', name: 'ChatGPT 5.2' },
];

export function AdminSettings({ defaultModel }: { defaultModel: string }) {
  const router = useRouter();
  const [model, setModel] = useState(defaultModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch('/api/admin/default-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to update');
      }
      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-6 space-y-4">
      <h2 className="text-lg font-medium">Default Model</h2>
      <p className="text-sm text-muted-foreground">
        The default model assigned to newly provisioned machines. This does not affect existing users.
      </p>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-500" role="status">
          Default model updated.
        </div>
      )}

      <div className="space-y-2">
        <Label>Model</Label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SWITCHABLE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button size="sm" disabled={saving || model === defaultModel} onClick={handleSave}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </section>
  );
}
