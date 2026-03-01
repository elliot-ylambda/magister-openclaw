'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UserSecretOverrides } from './user-secret-overrides';

export type GlobalSecret = {
  id: string;
  key: string;
  value: string;
  description: string;
  category: string;
  is_sensitive: boolean;
  created_at: string;
  updated_at: string;
};

export type SecretOverride = {
  id: string;
  user_id: string;
  secret_key: string;
  value: string;
  created_at: string;
  updated_at: string;
};

export type UserProfile = {
  id: string;
  email: string;
};

const CATEGORIES = ['general', 'search', 'scraping', 'analytics', 'ai', 'other'] as const;
const RESERVED_PREFIXES = ['GATEWAY_', 'SLACK_'];

type SecretsManagerProps = {
  secrets: GlobalSecret[];
  overrides: SecretOverride[];
  profiles: UserProfile[];
};

export function SecretsManager({ secrets, overrides, profiles }: SecretsManagerProps) {
  const router = useRouter();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

  function toggleReveal(key: string) {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function maskValue(value: string, isRevealed: boolean) {
    if (isRevealed) return value;
    if (value.length <= 4) return '****';
    return value.slice(0, 2) + '****' + value.slice(-2);
  }

  async function handlePushAll() {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch('/api/admin/secrets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setPushResult(`Error: ${data.error}`);
      } else {
        setPushResult(`Pushed to ${data.pushed} machines (${data.errors} errors)`);
      }
    } catch {
      setPushResult('Network error');
    } finally {
      setPushing(false);
    }
  }

  async function handleDelete(key: string) {
    const res = await fetch('/api/admin/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_global', key }),
    });
    if (res.ok) router.refresh();
  }

  const overridesByKey = new Map<string, SecretOverride[]>();
  for (const o of overrides) {
    const list = overridesByKey.get(o.secret_key) ?? [];
    list.push(o);
    overridesByKey.set(o.secret_key, list);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <AddSecretDialog onSuccess={() => router.refresh()} />
        <div className="flex items-center gap-3">
          {pushResult && (
            <span className="text-sm text-muted-foreground">{pushResult}</span>
          )}
          <Button onClick={handlePushAll} disabled={pushing} variant="outline">
            {pushing ? 'Pushing...' : 'Push to All Machines'}
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Key</TableHead>
            <TableHead className="w-[200px]">Value</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[100px]">Category</TableHead>
            <TableHead className="w-[80px]">Overrides</TableHead>
            <TableHead className="w-[140px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {secrets.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No secrets configured yet
              </TableCell>
            </TableRow>
          )}
          {secrets.map((secret) => {
            const keyOverrides = overridesByKey.get(secret.key) ?? [];
            const isExpanded = expandedKey === secret.key;
            const isRevealed = revealedKeys.has(secret.key);

            return (
              <TableRow key={secret.id} className="group">
                <TableCell className="font-mono text-xs">{secret.key}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <code className="text-xs">
                      {secret.is_sensitive
                        ? maskValue(secret.value, isRevealed)
                        : secret.value}
                    </code>
                    {secret.is_sensitive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1 text-xs"
                        onClick={() => toggleReveal(secret.key)}
                      >
                        {isRevealed ? 'Hide' : 'Show'}
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {secret.description}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {secret.category}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setExpandedKey(isExpanded ? null : secret.key)}
                  >
                    {keyOverrides.length} {isExpanded ? '▲' : '▼'}
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <EditSecretDialog secret={secret} onSuccess={() => router.refresh()} />
                    <DeleteSecretDialog secretKey={secret.key} onConfirm={() => handleDelete(secret.key)} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {expandedKey && (
        <div className="rounded-lg border p-4">
          <UserSecretOverrides
            secretKey={expandedKey}
            overrides={overridesByKey.get(expandedKey) ?? []}
            profiles={profiles}
            onUpdate={() => router.refresh()}
          />
        </div>
      )}
    </div>
  );
}

function AddSecretDialog({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    key: '',
    value: '',
    description: '',
    category: 'general',
    is_sensitive: true,
  });

  async function handleSubmit() {
    if (!form.key || !form.value) {
      setError('Key and value are required');
      return;
    }
    if (RESERVED_PREFIXES.some((p) => form.key.startsWith(p))) {
      setError(`Key cannot start with: ${RESERVED_PREFIXES.join(', ')}`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert_global', ...form }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        return;
      }
      setOpen(false);
      setForm({ key: '', value: '', description: '', category: 'general', is_sensitive: true });
      onSuccess();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add Secret</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Global Secret</DialogTitle>
          <DialogDescription>
            This secret will be available to all user machines.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key">Key</Label>
            <Input
              id="key"
              placeholder="BRAVE_SEARCH_API_KEY"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="value">Value</Label>
            <Input
              id="value"
              type="password"
              placeholder="sk-..."
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              placeholder="API key for Brave Search"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="is_sensitive"
              type="checkbox"
              checked={form.is_sensitive}
              onChange={(e) => setForm((f) => ({ ...f, is_sensitive: e.target.checked }))}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor="is_sensitive">Sensitive (mask value in UI)</Label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSecretDialog({ secret, onSuccess }: { secret: GlobalSecret; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    value: secret.value,
    description: secret.description,
    category: secret.category,
    is_sensitive: secret.is_sensitive,
  });

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert_global',
          key: secret.key,
          ...form,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        return;
      }
      setOpen(false);
      onSuccess();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) setForm({ value: secret.value, description: secret.description, category: secret.category, is_sensitive: secret.is_sensitive });
    }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {secret.key}</DialogTitle>
          <DialogDescription>Update this global secret.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-value">Value</Label>
            <Input
              id="edit-value"
              type="password"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Input
              id="edit-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-category">Category</Label>
            <select
              id="edit-category"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="edit-is_sensitive"
              type="checkbox"
              checked={form.is_sensitive}
              onChange={(e) => setForm((f) => ({ ...f, is_sensitive: e.target.checked }))}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor="edit-is_sensitive">Sensitive</Label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteSecretDialog({ secretKey, onConfirm }: { secretKey: string; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {secretKey}</DialogTitle>
          <DialogDescription>
            This will remove the global secret and all per-user overrides for this key.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
