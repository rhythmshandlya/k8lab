import Image from "next/image";
import Link from "next/link";

import { icons, type IconName } from "@/components/icons";
import { BRAND } from "@/config/brand";
import type { AuthCapabilities } from "@/lib/env";

import { EntryActions, HeaderEntryAction } from "./entry-actions";
import { ProductPreview } from "./product-preview";

const SURFACES = [
  {
    icon: "problems",
    label: "Problems",
    title: "Fix a failing cluster",
    description:
      "Follow events, logs, and topology to the fault. Change manifests, apply the fix, and validate the recovery.",
    tone: "blue",
    visual: "incident",
  },
  {
    icon: "docs",
    label: "Learn",
    title: "Understand why it works",
    description:
      "Run concise lessons with examples you can change in place. Send useful manifests into the Playground and keep experimenting.",
    tone: "purple",
    visual: "lesson",
  },
  {
    icon: "playground",
    label: "Playground",
    title: "Build your own setup",
    description:
      "Create and save multi-file experiments. Apply YAML, run commands, inspect topology, and return to the same workspace later.",
    tone: "green",
    visual: "workspace",
  },
] as const;

const SIMULATOR_FLOW = [
  {
    icon: "terminal",
    label: "Input",
    detail: "YAML and kubectl-style commands",
    sample: "kubectl apply -f deployment.yaml",
  },
  {
    icon: "cluster",
    label: "Reconcile",
    detail: "API objects and simulated controllers",
    sample: "Deployment → ReplicaSet → Pods",
  },
  {
    icon: "events",
    label: "Observe",
    detail: "Status, events, logs, and topology",
    sample: "availableReplicas: 3",
  },
] as const;

export function Landing({
  authEnabled,
  authCapabilities,
  destination,
}: {
  authEnabled: boolean;
  authCapabilities: AuthCapabilities;
  destination: string;
}) {
  return (
    <div className="bg-app relative isolate overflow-hidden">
      <BackgroundDecor />
      <header className="border-border/70 bg-app/85 sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-5 sm:px-8">
          <Link
            href="/"
            className="text-foreground flex items-center gap-2"
            aria-label={`${BRAND.name} home`}
          >
            <Image
              src={BRAND.logo.assets.lockupOnDark}
              alt=""
              width={107}
              height={32}
              className="h-8 w-auto"
              priority
            />
          </Link>

          <nav aria-label="Landing page" className="text-muted ml-auto flex items-center text-xs">
            <span className="rounded-md px-3 py-2" title="Blogs coming soon">
              Blogs
            </span>
          </nav>

          <HeaderEntryAction
            authEnabled={authEnabled}
            authCapabilities={authCapabilities}
            destination={destination}
          />
        </div>
      </header>

      <main>
        <section className="mx-auto grid w-full max-w-7xl items-center gap-9 px-5 pt-11 pb-14 sm:px-8 sm:pt-14 sm:pb-16 lg:grid-cols-[minmax(0,0.82fr)_minmax(560px,1.18fr)] lg:gap-12 lg:pt-16">
          <div>
            <h1 className="text-foreground max-w-3xl text-4xl leading-[1.06] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[4rem]">
              Learn production Kubernetes by fixing what breaks.
            </h1>
            <p className="text-muted mt-5 max-w-xl text-lg leading-relaxed text-pretty">
              Investigate incidents, edit YAML, and watch the cluster respond. No setup or cloud
              account needed.
            </p>

            <div id="start" className="mt-8 scroll-mt-24">
              <EntryActions
                authEnabled={authEnabled}
                authCapabilities={authCapabilities}
                destination={destination}
              />
            </div>
          </div>

          <ProductPreview />
        </section>

        <section id="simulator" className="border-border/70 scroll-mt-16 border-y bg-black/20">
          <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-12 sm:px-8 sm:py-14 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
            <div>
              <p className="text-blue text-xs font-semibold tracking-[0.16em] uppercase">
                How it works
              </p>
              <h2 className="text-foreground mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Kubernetes behavior, simulated in your browser.
              </h2>
              <p className="text-muted mt-4 max-w-lg text-sm leading-relaxed">
                Your manifests and commands become Kubernetes API objects inside an in-browser
                simulator. Simulated controllers reconcile desired state, while {BRAND.name}
                exposes the resulting resources, events, logs, endpoints, and topology.
              </p>
              <div className="border-border text-subtle mt-5 max-w-lg rounded-lg border bg-black/20 px-4 py-3 text-xs leading-relaxed">
                This is not a hidden remote cluster. It does not start real containers or replace a
                production environment. It models the control-plane behavior needed for fast,
                repeatable practice.
              </div>
            </div>

            <ol
              className="border-border bg-panel grid overflow-hidden rounded-2xl border md:grid-cols-3"
              aria-label="Kubernetes simulation flow"
            >
              {SIMULATOR_FLOW.map((step, index) => {
                const Icon = icons[step.icon];
                return (
                  <li
                    key={step.label}
                    className="border-border relative border-b p-5 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0"
                  >
                    <span className="border-border bg-panel-elevated flex size-9 items-center justify-center rounded-lg border">
                      <Icon className="text-blue size-4" aria-hidden />
                    </span>
                    <span className="text-subtle absolute top-5 right-5 font-mono text-[10px]">
                      0{index + 1}
                    </span>
                    <p className="text-foreground mt-5 text-sm font-semibold">{step.label}</p>
                    <p className="text-subtle mt-1 min-h-8 text-xs leading-relaxed">
                      {step.detail}
                    </p>
                    <div className="border-border bg-code text-muted mt-4 truncate rounded-md border px-3 py-2.5 font-mono text-[9px]">
                      {step.sample}
                    </div>
                    {index < SIMULATOR_FLOW.length - 1 ? (
                      <icons.chevronRight
                        className="text-blue bg-panel absolute top-1/2 -right-2.5 z-10 hidden size-5 rounded-full md:block"
                        aria-hidden
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section id="product" className="scroll-mt-16">
          <div className="mx-auto w-full max-w-7xl px-5 pt-12 pb-6 sm:px-8 sm:pt-14 sm:pb-7">
            <SectionIntro
              eyebrow={`Inside ${BRAND.name}`}
              title="Everything connects."
              description="Learn a concept, use it in a production incident, then take the same idea into your own workspace. Manifests, cluster state, tools, and progress stay connected across the experience."
            />
            <div className="mt-7 grid gap-4 lg:grid-cols-3">
              {SURFACES.map((surface) => (
                <SurfaceCard key={surface.label} {...surface} />
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-5 pt-0 pb-12 sm:px-8 sm:pb-14">
          <div className="border-blue/30 bg-panel relative overflow-hidden rounded-2xl border px-6 py-8 sm:px-9 sm:py-9">
            <div
              className="bg-blue/10 absolute -top-24 -right-8 size-64 rounded-full blur-3xl"
              aria-hidden
            />
            <div className="relative grid gap-7 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="max-w-xl">
                <p className="text-blue text-xs font-semibold tracking-[0.16em] uppercase">
                  Ready when you are
                </p>
                <h2 className="text-foreground mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                  Break a cluster. Fix it. Remember why.
                </h2>
                <p className="text-muted mt-3 text-sm leading-relaxed">
                  Open a production incident and start investigating in seconds.
                </p>
              </div>
              <EntryActions
                authEnabled={authEnabled}
                authCapabilities={authCapabilities}
                destination={destination}
                variant="cta"
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-border/70 border-t">
        <div className="text-subtle mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 py-7 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Image
            src={BRAND.logo.assets.lockupOnDark}
            alt={BRAND.name}
            width={80}
            height={24}
            className="h-6 w-auto"
          />
          <p>{BRAND.shortDescription}</p>
          <div className="flex items-center gap-4">
            <a className="hover:text-foreground transition-colors" href={BRAND.repositoryUrl}>
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div>
      <p className="text-blue text-xs font-semibold tracking-[0.16em] uppercase">{eyebrow}</p>
      <h2 className="text-foreground mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {description ? (
        <p className="text-muted mt-4 max-w-3xl text-sm leading-relaxed sm:text-base">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function SurfaceCard({ icon, label, title, description, tone, visual }: (typeof SURFACES)[number]) {
  const Icon = icons[icon as IconName];
  const accent = tone === "green" ? "text-green" : tone === "purple" ? "text-purple" : "text-blue";

  return (
    <article className="border-border bg-panel group flex flex-col overflow-hidden rounded-2xl border">
      <div className="p-5 sm:p-6">
        <p className={`flex items-center gap-2 text-xs font-semibold uppercase ${accent}`}>
          <Icon className="size-4" aria-hidden />
          {label}
        </p>
        <h3 className="text-foreground mt-3 text-xl font-semibold tracking-tight">{title}</h3>
        <p className="text-muted mt-2 text-sm">{description}</p>
      </div>
      <div className="mt-auto">
        <SurfaceVisual type={visual} />
      </div>
    </article>
  );
}

function SurfaceVisual({ type }: { type: (typeof SURFACES)[number]["visual"] }) {
  if (type === "incident") {
    return (
      <div className="border-border bg-code mx-4 mb-4 rounded-xl border p-4 font-mono text-[10px]">
        <p className="text-red">Warning Unhealthy</p>
        <p className="text-muted mt-2">readiness probe failed: 404</p>
        <div className="bg-border mt-4 h-px" />
        <p className="text-green mt-3">✓ deployment/web recovered</p>
      </div>
    );
  }

  if (type === "lesson") {
    return (
      <div className="border-border bg-code mx-4 mb-4 flex items-center gap-2 rounded-xl border p-4">
        <VisualNode icon="yaml" label="YAML" />
        <icons.arrowRight className="text-subtle size-4 shrink-0" aria-hidden />
        <VisualNode icon="deployment" label="Object" />
        <icons.arrowRight className="text-subtle size-4 shrink-0" aria-hidden />
        <VisualNode icon="cluster" label="State" />
      </div>
    );
  }

  return (
    <div className="border-border bg-code mx-4 mb-4 rounded-xl border p-4">
      <div className="flex gap-1.5 text-[9px]">
        <span className="border-blue/35 bg-blue/10 text-blue rounded border px-2 py-1">
          deployment.yaml
        </span>
        <span className="border-border text-subtle rounded border px-2 py-1">service.yaml</span>
      </div>
      <div className="mt-4 flex items-center justify-center gap-3">
        <VisualNode icon="service" label="Service" />
        <span className="bg-green h-px w-8" aria-hidden />
        <VisualNode icon="deployment" label="Pods" />
      </div>
    </div>
  );
}

function VisualNode({ icon, label }: { icon: IconName; label: string }) {
  const Icon = icons[icon];
  return (
    <span className="border-border bg-panel-elevated text-muted flex min-w-0 flex-1 flex-col items-center gap-2 rounded-md border px-2 py-3 text-[9px]">
      <Icon className="text-blue size-4" aria-hidden />
      {label}
    </span>
  );
}

function BackgroundDecor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div
        className="absolute inset-x-0 top-0 h-[720px] opacity-70"
        style={{
          background:
            "radial-gradient(55% 85% at 72% 8%, color-mix(in oklab, var(--color-blue) 16%, transparent) 0%, transparent 72%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--color-foreground) 1px, transparent 1px), linear-gradient(to bottom, var(--color-foreground) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(75% 48% at 62% 5%, black, transparent 82%)",
        }}
      />
    </div>
  );
}
