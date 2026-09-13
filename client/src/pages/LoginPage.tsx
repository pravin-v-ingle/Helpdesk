import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Navigate, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAuth } from "../auth/auth-context.ts";

/**
 * Client-side shape only. The server is still the authority on whether the
 * credentials are any good; this just avoids a round trip for an empty field
 * or an obvious typo in the address.
 *
 * No minimum length on the password: the rule lives in Better Auth's password
 * config, and guessing at it here would only invent a second, wrong one.
 */
const loginSchema = z.object({
  // Piped rather than `.email()`, which Zod 4 deprecates, and it short-circuits:
  // a blank field reports "enter your email", not that plus "invalid address".
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .pipe(z.email("Enter a valid email address.")),
  password: z.string().min(1, "Enter your password."),
});

type LoginValues = z.infer<typeof loginSchema>;

/**
 * There is no sign-up link on purpose: self-registration is disabled on the
 * server, and admins create accounts through `POST /api/users`.
 */
export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  // Wherever ProtectedRoute turned us away from, or the home page.
  const from =
    typeof location.state === "object" &&
    location.state !== null &&
    "from" in location.state &&
    typeof location.state.from === "string"
      ? location.state.from
      : "/";

  if (auth.status === "authenticated") return <Navigate to={from} replace />;

  const onSubmit = handleSubmit(async ({ email, password }) => {
    try {
      const message = await auth.signIn(email, password);
      if (message) {
        // Whatever the server said - bad credentials, deactivated account.
        // `root` is react-hook-form's slot for errors that belong to the form
        // rather than to one field, and it clears itself on the next submit.
        setError("root", { message });
        return;
      }
      void navigate(from, { replace: true });
    } catch {
      setError("root", {
        message: "Could not reach the server. Please try again.",
      });
    }
  });

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Helpdesk agent and admin access.</CardDescription>
        </CardHeader>

        {/* The form wraps content and footer, so it has to carry the Card's
            own column gap or the two sit flush. */}
        <form
          className="flex flex-col gap-(--card-spacing)"
          onSubmit={(event) => void onSubmit(event)}
          noValidate
        >
          <CardContent>
            <FieldGroup>
              <Field data-invalid={errors.email ? true : undefined}>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  aria-invalid={errors.email ? true : undefined}
                  {...register("email")}
                />
                <FieldError errors={[errors.email]} />
              </Field>

              <Field data-invalid={errors.password ? true : undefined}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={errors.password ? true : undefined}
                  {...register("password")}
                />
                <FieldError errors={[errors.password]} />
              </Field>
            </FieldGroup>

            {/* Announced to screen readers when sign-in is refused. Reserves
                its line so the card does not jump when a message appears. */}
            <p className="mt-2 min-h-2 text-sm text-destructive" role="alert">
              {errors.root?.message}
            </p>
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
