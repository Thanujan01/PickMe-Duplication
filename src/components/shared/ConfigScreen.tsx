import { Settings2 } from 'lucide-react';

/**
 * Shown instead of the app when required environment variables are missing, so
 * a misconfigured deploy explains itself rather than throwing a blank screen
 * (spec section 9 / section 21).
 */
export function ConfigScreen({ errors }: { errors: string[] }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-card">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-full bg-warning/15 p-2.5">
            <Settings2 className="h-5 w-5 text-warning" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Configuration needed</h1>
            <p className="text-sm text-muted-foreground">
              The app cannot start until these are set.
            </p>
          </div>
        </div>

        <ul className="mb-6 space-y-2">
          {errors.map((e) => (
            <li
              key={e}
              className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm"
            >
              {e}
            </li>
          ))}
        </ul>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">How to fix</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Copy <code className="rounded bg-muted px-1 py-0.5 text-xs">.env.example</code> to{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">.env</code>
            </li>
            <li>
              Create a free project at{' '}
              <a
                className="font-medium text-foreground underline underline-offset-4"
                href="https://supabase.com/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                supabase.com/dashboard
              </a>
            </li>
            <li>
              Paste the Project URL and the <strong>anon public</strong> key from Project Settings →
              API
            </li>
            <li>Restart the dev server, or redeploy with the variables set on your host</li>
          </ol>
          <p className="pt-2">
            Full walkthrough: <code className="rounded bg-muted px-1 py-0.5 text-xs">README.md</code>
          </p>
        </div>
      </div>
    </div>
  );
}
