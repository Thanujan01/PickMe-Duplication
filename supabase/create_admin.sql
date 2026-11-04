-- =============================================================================
-- Create (or reset) an administrator account
--
-- Run the whole file in the Supabase SQL editor. It creates the auth user,
-- marks the address confirmed so no email is needed, creates the profile, and
-- grants the admin role - in one go, idempotently.
--
-- Re-running it on an existing email resets that account's password and
-- re-grants admin, which is also how you recover a forgotten password.
--
-- CHANGE THE TWO VALUES AT THE BOTTOM before running.
--
-- NOTE: the password appears in plain text in this file and in the SQL
-- editor's history. Change it from inside the app once you are signed in, or
-- re-run this with a new one.
-- =============================================================================

create or replace function public.create_admin(
  p_email    text,
  p_password text,
  p_name     text default null
)
returns table (status text, email text, user_id uuid, role text)
language plpgsql
security definer
set search_path = public, auth, extensions
as $fn$
declare
  v_id     uuid;
  v_email  text := lower(trim(p_email));
  v_name   text := coalesce(nullif(trim(p_name), ''), split_part(lower(trim(p_email)), '@', 1));
  v_new    boolean := false;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That does not look like an email address: %', p_email;
  end if;
  if length(p_password) < 8 then
    raise exception 'Use a password of at least 8 characters.';
  end if;

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    -- ---------------------------------------------------------------------
    -- New account. The text columns are set to '' rather than left NULL
    -- because some GoTrue versions fail to read a NULL token column.
    -- ---------------------------------------------------------------------
    v_id := gen_random_uuid();
    v_new := true;

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_email, extensions.crypt(p_password, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_name),
      '', '', '', ''
    );
  else
    -- Existing account: reset the password and make sure it is confirmed.
    update auth.users
       set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at         = now()
     where id = v_id;
  end if;

  -- -----------------------------------------------------------------------
  -- GoTrue expects a matching identity row for the email provider. Best
  -- effort: the table's shape has changed between versions, and a missing
  -- identity does not stop password sign-in, so a failure here must not
  -- abort the whole thing.
  -- -----------------------------------------------------------------------
  begin
    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_id::text, v_id,
      jsonb_build_object(
        'sub', v_id::text, 'email', v_email,
        'email_verified', true, 'phone_verified', false
      ),
      'email', now(), now(), now()
    )
    on conflict do nothing;
  exception when others then
    raise notice 'Could not write auth.identities (%). Password sign-in still works.', sqlerrm;
  end;

  -- -----------------------------------------------------------------------
  -- Profile + admin role. handle_new_user() may already have made the row.
  -- -----------------------------------------------------------------------
  insert into public.profiles (id, role, full_name)
  values (v_id, 'admin', v_name)
  on conflict (id) do update
     set role      = 'admin',
         full_name = coalesce(nullif(public.profiles.full_name, ''), v_name);

  -- An admin is not a driver; drop any rider row a previous signup created so
  -- they cannot appear in dispatch.
  delete from public.riders where id = v_id;

  return query
  select
    case when v_new then 'created' else 'password reset + promoted' end,
    v_email,
    v_id,
    'admin'::text;
end;
$fn$;

revoke all on function public.create_admin(text, text, text)
  from public, anon, authenticated;


-- =============================================================================
-- EDIT THESE, THEN RUN
-- =============================================================================
select * from public.create_admin(
  'thanujan052@gmail.com',   -- email you will sign in with
  'Thanujan@admin',          -- password you will sign in with
  'Thanujan'                 -- display name
);


-- =============================================================================
-- Confirm it worked
-- =============================================================================
select u.email,
       p.role,
       u.email_confirmed_at is not null as confirmed,
       p.full_name
from auth.users u
join public.profiles p on p.id = u.id
order by p.role, u.created_at;
