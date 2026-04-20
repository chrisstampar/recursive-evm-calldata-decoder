# Error boundary usage

[`ErrorBoundary`](../src/components/ErrorBoundary.tsx) supports `fallback`, `onError`, and `onReset`. Use **`onError`** for logging or services like Sentry (it runs in dev and prod). **`onReset`** runs only when the **built-in** “Try again” path is used—if you pass a custom `fallback`, wire recovery (and any cache clear) inside that UI yourself.

**Larger surfaces (routes, layout shells)** — custom fallback plus monitoring:

```tsx
<ErrorBoundary
  fallback={<RouteErrorFallback />}
  onError={logToSentry}
>
  <RouterProvider router={router} />
</ErrorBoundary>
```

**Isolated widgets** — refresh data on reset; surface failures to the user:

```tsx
<ErrorBoundary
  onReset={refreshData}
  onError={() => toast.error('Widget failed')}
>
  <ComplexChart />
</ErrorBoundary>
```

`RouteErrorFallback`, `logToSentry`, `refreshData`, and `toast` are placeholders for your app’s components and helpers.
