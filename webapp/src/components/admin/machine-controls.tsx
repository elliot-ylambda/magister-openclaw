'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type MachineControlsProps = {
  userId: string;
  machineStatus: string | null;
  onActionComplete?: () => void;
};

export function MachineControls({ userId, machineStatus, onActionComplete }: MachineControlsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);

  async function handleAction(action: 'restart' | 'suspend') {
    setLoading(action);
    setError(null);
    try {
      const res = await fetch('/api/admin/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, user_id: userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Action failed');
        return;
      }
      setRestartOpen(false);
      setSuspendOpen(false);
      onActionComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(null);
    }
  }

  if (!machineStatus) {
    return <span className="text-xs text-muted-foreground">No machine</span>;
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}

      {machineStatus !== 'running' && machineStatus !== 'provisioning' && (
        <Dialog open={restartOpen} onOpenChange={setRestartOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={loading !== null}>
              Restart
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restart agent</DialogTitle>
              <DialogDescription>
                This will re-provision the agent for this user. Are you sure?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestartOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => handleAction('restart')}
                disabled={loading === 'restart'}
              >
                {loading === 'restart' ? 'Restarting...' : 'Restart'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {machineStatus === 'running' && (
        <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={loading !== null}>
              Suspend
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Suspend agent</DialogTitle>
              <DialogDescription>
                This will destroy the agent machine for this user. Are you sure?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSuspendOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleAction('suspend')}
                disabled={loading === 'suspend'}
              >
                {loading === 'suspend' ? 'Suspending...' : 'Suspend'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
