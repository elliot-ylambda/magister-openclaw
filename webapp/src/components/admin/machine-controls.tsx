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

type Action = 'stop' | 'start' | 'restart' | 'reset' | 'destroy';

type ActionConfig = {
  label: string;
  loadingLabel: string;
  variant: 'outline' | 'destructive';
  dialogTitle: string;
  dialogDescription: string;
  visible: (status: string) => boolean;
};

const ACTIONS: Record<Action, ActionConfig> = {
  stop: {
    label: 'Stop',
    loadingLabel: 'Stopping...',
    variant: 'outline',
    dialogTitle: 'Stop agent',
    dialogDescription: 'This will stop the agent. The user must manually start it.',
    visible: (s) => s === 'running',
  },
  start: {
    label: 'Start',
    loadingLabel: 'Starting...',
    variant: 'outline',
    dialogTitle: 'Start agent',
    dialogDescription: 'This will start the agent.',
    visible: (s) => s === 'stopped' || s === 'suspended',
  },
  restart: {
    label: 'Restart',
    loadingLabel: 'Restarting...',
    variant: 'outline',
    dialogTitle: 'Restart agent',
    dialogDescription: 'This will restart the agent. No data is lost.',
    visible: (s) => s === 'running',
  },
  reset: {
    label: 'Reset',
    loadingLabel: 'Resetting...',
    variant: 'destructive',
    dialogTitle: 'Reset agent',
    dialogDescription: 'This will delete all agent data and re-provision from scratch.',
    visible: (s) => !['destroyed', 'provisioning', 'destroying'].includes(s),
  },
  destroy: {
    label: 'Destroy',
    loadingLabel: 'Destroying...',
    variant: 'destructive',
    dialogTitle: 'Destroy agent',
    dialogDescription: 'This will permanently destroy the agent and all its data. A new one will need to be provisioned.',
    visible: (s) => s !== 'destroyed',
  },
};

const ACTION_ORDER: Action[] = ['stop', 'start', 'restart', 'reset', 'destroy'];

type MachineControlsProps = {
  userId: string;
  machineStatus: string | null;
  flyAppName: string | null;
  onActionComplete?: () => void;
};

export function MachineControls({ userId, machineStatus, flyAppName, onActionComplete }: MachineControlsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<Action | null>(null);
  const [copied, setCopied] = useState(false);

  function copySSHCommand() {
    if (!flyAppName) return;
    navigator.clipboard.writeText(`fly ssh console -a ${flyAppName}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleAction(action: Action) {
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
      setOpenDialog(null);
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

  const visibleActions = ACTION_ORDER.filter((a) => ACTIONS[a].visible(machineStatus));

  return (
    <div className="flex items-center gap-2">
      {flyAppName && (
        <Button variant="outline" size="sm" onClick={copySSHCommand}>
          {copied ? 'Copied!' : 'SSH'}
        </Button>
      )}

      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}

      {visibleActions.map((action) => {
        const config = ACTIONS[action];
        return (
          <Dialog
            key={action}
            open={openDialog === action}
            onOpenChange={(open) => setOpenDialog(open ? action : null)}
          >
            <DialogTrigger asChild>
              <Button variant={config.variant} size="sm" disabled={loading !== null}>
                {config.label}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{config.dialogTitle}</DialogTitle>
                <DialogDescription>{config.dialogDescription}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpenDialog(null)}>
                  Cancel
                </Button>
                <Button
                  variant={config.variant === 'destructive' ? 'destructive' : 'default'}
                  onClick={() => handleAction(action)}
                  disabled={loading === action}
                >
                  {loading === action ? config.loadingLabel : config.label}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })}
    </div>
  );
}
