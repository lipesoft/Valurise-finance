"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type SharedGoalInvite = {
  id: string;
  shared_goal_id: string;
  status: "pending";
  created_at: string;
  shared_goals: {
    name: string;
    target_cents: number;
    target_date: string | null;
  } | null;
};

export type SharedGoalContribution = {
  id: string;
  user_id: string;
  amount_cents: number;
  note: string | null;
  contributed_at: string;
};

export type SharedGoalSummary = {
  id: string;
  name: string;
  target_cents: number;
  target_date: string | null;
  initial_cents: number;
  created_at: string;
  current_cents: number;
  shared_goal_contributions: SharedGoalContribution[];
};

type InviteFeedback = (message: string) => void;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keeps incoming invitations and accepted shared-goal balances current. */
export function useSharedGoalInvites(
  userId: string,
  localSharedGoalIds: string[],
  feedback: InviteFeedback,
) {
  const [invites, setInvites] = useState<SharedGoalInvite[]>([]);
  const [sharedGoals, setSharedGoals] = useState<SharedGoalSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [realtimeAvailable, setRealtimeAvailable] = useState<boolean | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const knownIds = useRef(new Set<string>());
  const hasLoaded = useRef(false);
  const feedbackRef = useRef(feedback);

  useEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;

    const [pendingResult, acceptedResult] = await Promise.all([
      supabase
        .from("shared_goal_invites")
        .select("id, shared_goal_id, status, created_at, shared_goals(name, target_cents, target_date)")
        .eq("recipient_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase
        .from("shared_goal_invites")
        .select("shared_goal_id")
        .eq("recipient_id", userId)
        .eq("status", "accepted"),
    ]);

    if (pendingResult.error || acceptedResult.error) {
      setLoadError(true);
      return;
    }

    const nextInvites = (pendingResult.data || []) as unknown as SharedGoalInvite[];
    if (hasLoaded.current && nextInvites.some((invite) => !knownIds.current.has(invite.id))) {
      feedbackRef.current("Você recebeu um convite de meta. Confira no sino de notificações.");
    }
    knownIds.current = new Set(nextInvites.map((invite) => invite.id));
    hasLoaded.current = true;

    const acceptedIds = (acceptedResult.data || []).map((invite) => invite.shared_goal_id);
    const goalIds = [...new Set([...localSharedGoalIds, ...acceptedIds])]
      .filter((id): id is string => typeof id === "string" && uuidPattern.test(id));
    let nextGoals: SharedGoalSummary[] = [];
    if (goalIds.length) {
      const goalsResult = await supabase
        .from("shared_goals")
        .select("id, name, target_cents, target_date, created_at, shared_goal_contributions(id, user_id, amount_cents, note, contributed_at)")
        .in("id", goalIds);
      if (goalsResult.error) {
        setLoadError(true);
        return;
      }
      nextGoals = ((goalsResult.data || []) as unknown as Omit<SharedGoalSummary, "current_cents" | "initial_cents">[])
        .map((goal) => {
          const contributions = (goal.shared_goal_contributions || [])
            .map((contribution) => ({
              ...contribution,
              amount_cents: Number(contribution.amount_cents),
            }))
            .sort((a, b) => b.contributed_at.localeCompare(a.contributed_at));
          const openingBalance = contributions
            .filter((contribution) => contribution.note === "Saldo ao compartilhar")
            .reduce((total, contribution) => total + contribution.amount_cents, 0);
          return {
            ...goal,
            initial_cents: openingBalance,
            target_cents: Number(goal.target_cents),
            current_cents: contributions.reduce((total, contribution) => total + contribution.amount_cents, 0),
            shared_goal_contributions: contributions,
          };
        });
    }

    setInvites(nextInvites);
    setSharedGoals(nextGoals);
    setLoadError(false);
  }, [localSharedGoalIds, userId]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;

    let disposed = false;
    const refreshWhenVisible = () => {
      if (!disposed && document.visibilityState !== "hidden") void refresh();
    };

    refreshWhenVisible();
    const channel = process.env.NEXT_PUBLIC_SUPABASE_REALTIME_ENABLED === "false"
      ? null
      : supabase
          .channel(`shared-goals:${userId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "shared_goal_invites",
              filter: `recipient_id=eq.${userId}`,
            },
            () => refreshWhenVisible(),
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "shared_goal_contributions" },
            () => refreshWhenVisible(),
          )
          .subscribe((status) => {
            if (status === "SUBSCRIBED") setRealtimeAvailable(true);
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setRealtimeAvailable(false);
          });

    const poll = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [refresh, userId]);

  const respond = useCallback(async (inviteId: string, accept: boolean) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || respondingId) return false;

    setRespondingId(inviteId);
    const { error } = await supabase.rpc("respond_shared_goal_invite", {
      p_invite_id: inviteId,
      p_accept: accept,
    });
    if (error) {
      feedbackRef.current("Não foi possível responder ao convite. Atualize a lista e tente novamente.");
      setRespondingId(null);
      return false;
    }

    await refresh();
    feedbackRef.current(accept ? "Meta compartilhada adicionada às suas metas." : "Convite recusado.");
    setRespondingId(null);
    return true;
  }, [refresh, respondingId]);

  return { invites, sharedGoals, loadError, realtimeAvailable, respondingId, refresh, respond };
}
