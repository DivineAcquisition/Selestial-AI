import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state: { signUp: Record<string, unknown>; signIn: Record<string, unknown>; signedIn: boolean; search: string } = { signUp: {}, signIn: {}, signedIn: false, search: "" };

vi.mock("@clerk/nextjs", () => ({
  useSignIn: () => ({ signIn: { status: "needs_identifier", ...state.signIn }, fetchStatus: "idle" }),
  useSignUp: () => ({ signUp: { missingFields: [], ...state.signUp } }),
  useAuth: () => ({ isLoaded: true, isSignedIn: state.signedIn }),
  useClerk: () => ({ session: null }),
  HandleSSOCallback: () => null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams(state.search), usePathname: () => "/login" }));

const { LoginScreen } = await import("./login");
const { SignupScreen } = await import("./signup");
const { ContinueScreen, googleRequest, SsoCallbackScreen } = await import("./google");

const reset = () => Object.assign(state, { signUp: {}, signIn: {}, signedIn: false, search: "" });

describe("signing in and creating an account with Google", () => {
  it("offers Google on the sign-in page only when it is turned on", () => {
    reset();
    expect(renderToStaticMarkup(<LoginScreen google />)).toContain("Continue with Google");
    expect(renderToStaticMarkup(<LoginScreen />)).not.toContain("Continue with Google");
  });

  it("holds Google on the sign-up page until the agreement is ticked", () => {
    reset();
    const page = renderToStaticMarkup(<SignupScreen policy={null} google />);
    expect(page).toContain("Continue with Google");
    expect(page).toMatch(/data-testid="google"[^>]*disabled=""|disabled=""[^>]*data-testid="google"/);
    expect(page).toContain("Tick the agreement above to continue with Google.");
  });

  it("sends the checked destination both ways, and the agreement only when creating an account", () => {
    expect(googleRequest("signin", "/invite/abc.def")).toEqual({ strategy: "oauth_google", redirectUrl: "/auth/callback?next=%2Finvite%2Fabc.def", redirectCallbackUrl: "/auth/sso-callback?next=%2Finvite%2Fabc.def" });
    expect(googleRequest("signup", null)).toEqual({ strategy: "oauth_google", redirectUrl: "/auth/callback", redirectCallbackUrl: "/auth/sso-callback", legalAccepted: true });
    expect(googleRequest("signin", "https://evil.example")).toMatchObject({ redirectUrl: "/auth/callback", redirectCallbackUrl: "/auth/sso-callback" });
  });

  it("finishes a first Google sign-in by asking for the agreement, and a name only when Google gave none", () => {
    reset();
    state.signUp = { id: "su_1", status: "missing_requirements", missingFields: ["legal_accepted"], emailAddress: "maria@example.test", firstName: "Maria", lastName: "Lopez" };
    const page = renderToStaticMarkup(<ContinueScreen />);
    expect(page).toContain("One last step");
    expect(page).toContain("maria@example.test");
    expect(page).toContain("Terms of Service");
    expect(page).not.toContain("Full name");
    state.signUp = { ...state.signUp, missingFields: ["legal_accepted", "first_name", "last_name"], firstName: null, lastName: null };
    expect(renderToStaticMarkup(<ContinueScreen />)).toContain("Full name");
  });

  it("creates nothing when the service asks for something this page can't", () => {
    reset();
    state.signUp = { id: "su_1", status: "missing_requirements", missingFields: ["legal_accepted", "phone_number"], emailAddress: "maria@example.test" };
    expect(renderToStaticMarkup(<ContinueScreen />)).toContain("Sign-up isn’t available right now");
    state.signUp = { status: "complete", missingFields: [] };
    expect(renderToStaticMarkup(<ContinueScreen />)).toContain("There is nothing to finish here");
  });

  it("shows Google's return while the session is confirmed", () => {
    reset();
    expect(renderToStaticMarkup(<SsoCallbackScreen />)).toContain("Finishing with Google");
  });
});
