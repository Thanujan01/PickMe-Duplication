import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Car, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { signUp } from '@/features/auth/api';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(80),
  email: z.string().email('Enter a valid email address'),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9 ()-]{6,24}$/, 'Enter a valid phone number'),
  password: z.string().min(8, 'Use at least 8 characters'),
});

type Values = z.infer<typeof schema>;

export default function Register() {
  const navigate = useNavigate();
  const [role, setRole] = React.useState<'customer' | 'rider'>('customer');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: Values) => {
    try {
      const result = await signUp({ ...values, role });

      // With email confirmation enabled there is no session yet.
      if (!result.session) {
        toast.success('Check your email to confirm your account, then sign in.');
        navigate('/login', { replace: true });
        return;
      }

      toast.success(role === 'rider' ? 'Rider account created' : 'Account created');
      navigate(role === 'rider' ? '/rider' : '/', { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create your account');
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-background px-5 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">It takes about a minute.</p>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Account type">
          {(
            [
              { value: 'customer', label: 'I need rides', icon: UserRound },
              { value: 'rider', label: 'I drive', icon: Car },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={role === value}
              onClick={() => setRole(value)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition',
                role === value
                  ? 'border-primary bg-secondary ring-1 ring-primary'
                  : 'border-border hover:bg-secondary/60',
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-sm font-semibold">{label}</span>
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="fullName">Full name</Label>
            <Input id="fullName" autoComplete="name" placeholder="Jane Perera" {...register('fullName')} />
            {errors.fullName && <p className="text-xs text-destructive">{errors.fullName.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register('email')}
            />
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+94 77 123 4567"
              {...register('phone')}
            />
            {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
            <p className="text-xs text-muted-foreground">
              Shared with your {role === 'rider' ? 'customer' : 'rider'} only during an active ride.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              {...register('password')}
            />
            {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
          </div>

          <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
            Create account
          </Button>
        </form>

        {role === 'rider' && (
          <p className="mt-4 rounded-lg bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
            An administrator adds your vehicle details before you can accept rides.
          </p>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
