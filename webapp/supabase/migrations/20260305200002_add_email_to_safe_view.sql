-- Add email_address to safe view
DROP VIEW IF EXISTS public.user_machines_safe;
CREATE VIEW public.user_machines_safe AS
SELECT id, user_id, fly_app_name, fly_region, status, last_activity,
       plan, max_agents, preferred_model, email_address, pending_image, current_image,
       provisioning_step, created_at, updated_at
FROM public.user_machines;
