-- Migration: Add 'stopped' and 'stopping' to user_machines status constraint
-- 'stopped' = user explicitly stopped the agent (must manually start)
-- 'stopping' = transient state during stop operation (prevents race conditions)

ALTER TABLE public.user_machines
    DROP CONSTRAINT valid_status,
    ADD CONSTRAINT valid_status CHECK (status IN (
        'provisioning', 'running', 'suspending', 'suspended',
        'stopped', 'stopping',
        'failed', 'destroying', 'destroyed'
    ));
