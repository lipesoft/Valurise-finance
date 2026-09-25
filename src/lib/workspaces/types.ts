export type WorkspaceType = "personal" | "business";
export type WorkspaceRole = "owner" | "admin" | "finance" | "accountant" | "viewer";

export type WorkspaceSummary = {
  id: string;
  type: WorkspaceType;
  displayName: string;
  role: WorkspaceRole;
};

export type ActiveWorkspaceContext = WorkspaceSummary & {
  userId: string;
};
