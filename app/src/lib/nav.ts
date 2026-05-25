// Shared view-routing types for the app shell (no router lib — a tagged union
// + a navigate callback threaded through the components).

export type Route =
  | { name: 'projects' }
  | { name: 'create' }
  | { name: 'onboarding'; projectId: string }
  | { name: 'project'; projectId: string }
  | { name: 'settings' }

export type Navigate = (r: Route) => void
