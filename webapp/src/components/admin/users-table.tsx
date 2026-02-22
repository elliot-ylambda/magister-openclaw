'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MachineControls } from './machine-controls';

export type AdminUser = {
  id: string;
  email: string;
  plan: string | null;
  subStatus: string | null;
  machineStatus: string | null;
  flyRegion: string | null;
  llmSpendCents: number;
  budgetDollars: number;
  lastActivity: string | null;
};

type SortField = 'email' | 'plan' | 'machineStatus' | 'llmSpendCents' | 'lastActivity';
type SortDir = 'asc' | 'desc';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-emerald-500',
  suspended: 'bg-yellow-500',
  provisioning: 'bg-blue-500',
  failed: 'bg-red-500',
  destroying: 'bg-gray-500',
  destroyed: 'bg-gray-500',
  suspending: 'bg-yellow-500',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function UsersTable({ users }: { users: AdminUser[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [planFilter, setPlanFilter] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('email');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  }

  const filteredUsers = useMemo(() => {
    let result = users;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter((u) => u.email.toLowerCase().includes(q));
    }

    if (statusFilter) {
      result = result.filter((u) => u.machineStatus === statusFilter);
    }

    if (planFilter) {
      result = result.filter((u) => u.plan === planFilter);
    }

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'email':
          cmp = a.email.localeCompare(b.email);
          break;
        case 'plan':
          cmp = (a.plan ?? '').localeCompare(b.plan ?? '');
          break;
        case 'machineStatus':
          cmp = (a.machineStatus ?? '').localeCompare(b.machineStatus ?? '');
          break;
        case 'llmSpendCents':
          cmp = a.llmSpendCents - b.llmSpendCents;
          break;
        case 'lastActivity':
          cmp = (a.lastActivity ?? '').localeCompare(b.lastActivity ?? '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [users, search, statusFilter, planFilter, sortField, sortDir]);

  // Unique statuses and plans for filters
  const statuses = [...new Set(users.map((u) => u.machineStatus).filter(Boolean))] as string[];
  const plans = [...new Set(users.map((u) => u.plan).filter(Boolean))] as string[];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex items-center gap-2">
          <Button
            variant={statusFilter === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(null)}
          >
            All statuses
          </Button>
          {statuses.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={planFilter === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setPlanFilter(null)}
          >
            All plans
          </Button>
          {plans.map((p) => (
            <Button
              key={p}
              variant={planFilter === p ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPlanFilter(p)}
              className="uppercase"
            >
              {p}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => toggleSort('email')}
              >
                Email{sortIndicator('email')}
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => toggleSort('plan')}
              >
                Plan{sortIndicator('plan')}
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => toggleSort('machineStatus')}
              >
                Agent Status{sortIndicator('machineStatus')}
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-right"
                onClick={() => toggleSort('llmSpendCents')}
              >
                LLM Spend{sortIndicator('llmSpendCents')}
              </TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => toggleSort('lastActivity')}
              >
                Last Active{sortIndicator('lastActivity')}
              </TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-mono text-sm">{user.email}</TableCell>
                  <TableCell>
                    {user.plan ? (
                      <span className="uppercase text-xs font-medium">{user.plan}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.machineStatus ? (
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${STATUS_COLORS[user.machineStatus] ?? 'bg-gray-500'}`}
                        />
                        <span className="text-sm capitalize">{user.machineStatus}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">No agent</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    ${(user.llmSpendCents / 100).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    ${user.budgetDollars}/mo
                  </TableCell>
                  <TableCell className="text-sm">
                    {user.lastActivity ? formatRelativeTime(user.lastActivity) : 'Never'}
                  </TableCell>
                  <TableCell>
                    <MachineControls
                      userId={user.id}
                      machineStatus={user.machineStatus}
                      onActionComplete={() => router.refresh()}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {filteredUsers.length} of {users.length} user{users.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
