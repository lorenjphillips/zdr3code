import { expect, it } from "@effect/vitest";
import { CommandId, NodeId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Store from "./FeedbackStore.ts";

const threadId = ThreadId.make("thread:feedback");

type CardRecord = Extract<
  Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0],
  { readonly type: "feedback_request.record" }
>;

const outline = {
  turns: 1,
  textTurns: 0,
  truncated: false,
  entries: [{ turn: 1, type: "user" as const, length: 6 }],
};
const conversation = {
  ...outline,
  textTurns: 1,
  entries: [{ turn: 1, type: "user" as const, length: 6, text: "Ask 1." }],
};
const report = {
  kind: "bug" as const,
  subject: "t3_thread_read",
  expected: "Items for a completed thread.",
  actual: "No items.",
  workaround: "",
};

const harness = Effect.gen(function* () {
  // Every feedback card record, in order.
  const cards = yield* Queue.unbounded<CardRecord>();
  // The cards as the thread stores them, each its latest record.
  const shown = yield* Ref.make(new Map<string, CardRecord>());
  const failRecords = yield* Ref.make(false);
  // The projection rows the store reads share the database, as in the server.
  const threads = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const project = (card: CardRecord) => sql`
        INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: card.turnItemId,
          thread_id: threadId,
          run_id: card.runId,
          ordinal: 0,
          type: "feedback_request",
          status:
            card.feedbackStatus === "pending"
              ? "waiting"
              : card.feedbackStatus === "sent"
                ? "completed"
                : "cancelled",
          updated_at: "2026-01-01T00:00:00.000Z",
          payload_json: "{}",
        })}
        ON CONFLICT (turn_item_id) DO UPDATE SET status = excluded.status
        WHERE orchestration_v2_projection_turn_items.status = 'waiting'`;
      return Layer.mock(Threads.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            const card = command as CardRecord;
            if (card.feedbackStatus !== "pending" && (yield* Ref.get(failRecords))) {
              return yield* Effect.fail("The card record failed.");
            }
            yield* Ref.update(shown, (cards) => {
              const existing = cards.get(card.turnItemId);
              // A decided card stays decided, as the orchestrator keeps it.
              return existing === undefined || existing.feedbackStatus === "pending"
                ? new Map(cards).set(card.turnItemId, card)
                : cards;
            });
            yield* project(card).pipe(Effect.orDie);
            yield* Queue.offer(cards, card);
            return {};
          }) as never,
        getThreadRecords: () =>
          Ref.get(shown).pipe(
            Effect.map((cards) => ({
              turnItems: [...cards.values()].map(
                ({ type: _record, commandId: _id, turnItemId, ...card }) => ({
                  ...card,
                  type: "feedback_request",
                  id: turnItemId,
                }),
              ),
            })),
          ) as never,
      });
    }),
  );
  const layer = Store.layer.pipe(
    Layer.provideMerge(threads),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { cards, shown, failRecords, layer };
});

/** Records a card waiting for its answer, holding its outline and its conversation. */
const show = (cards: Queue.Queue<CardRecord>, reportId: string) =>
  Effect.gen(function* () {
    const threads = yield* Threads.ThreadManagementService;
    yield* threads.dispatch({
      type: "feedback_request.record",
      commandId: CommandId.make(`feedback-request:${reportId}:pending`),
      threadId,
      runId: RunId.make("run:1"),
      nodeId: NodeId.make("node:1"),
      turnItemId: TurnItemId.make(`turn-item:feedback-request:${reportId}`),
      preview: { ...report, trace: outline },
      conversationTrace: conversation,
      feedbackStatus: "pending",
    });
    return yield* Queue.take(cards);
  });

const answer = (card: CardRecord, reply: "send" | "decline") =>
  Effect.gen(function* () {
    const store = yield* Store.FeedbackStore;
    yield* store.answer({
      threadId,
      turnItemId: card.turnItemId,
      answer: reply,
      includeConversation: true,
    });
  });

it.effect("either answer closes the card unsent, once, and stores nothing", () =>
  Effect.gen(function* () {
    const { cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      // Decline: the card drops the conversation it held.
      const declined = yield* show(cards, "declined");
      yield* answer(declined, "decline");
      const closed = yield* Queue.take(cards);
      expect(closed).toMatchObject({ feedbackStatus: "declined", preview: declined.preview });
      expect(closed.conversationTrace).toBeUndefined();
      // A decided card takes no second answer.
      expect((yield* Effect.flip(answer(declined, "send"))).reason).toBe("already_answered");

      // Only the thread that asked answers, and only its feedback cards.
      const store = yield* Store.FeedbackStore;
      for (const [thread, turnItemId] of [
        [ThreadId.make("thread:fork"), declined.turnItemId],
        [threadId, TurnItemId.make("turn-item:assistant-message:1")],
      ] as const) {
        expect(
          (yield* Effect.flip(store.answer({ threadId: thread, turnItemId, answer: "send" })))
            .reason,
        ).toBe("not_found");
      }

      // Send: the card closes unsent with the outline only, and the answer says so.
      const refused = yield* show(cards, "refused");
      expect((yield* Effect.flip(answer(refused, "send"))).reason).toBe("feedback_off");
      const unsent = yield* Queue.take(cards);
      expect(unsent).toMatchObject({ feedbackStatus: "cancelled", preview: refused.preview });
      expect(unsent.conversationTrace).toBeUndefined();

      // Two answers at once, from two clients or a double tap: exactly one takes effect.
      for (const [reportId, replies] of [
        ["raced:1", ["send", "send"]],
        ["raced:2", ["send", "decline"]],
        ["raced:3", ["decline", "send"]],
      ] as const) {
        const raced = yield* show(cards, reportId);
        const results = yield* Effect.all(
          replies.map((reply) => Effect.result(answer(raced, reply))),
          { concurrency: "unbounded" },
        );
        expect(
          results.filter(
            (result) => result._tag === "Failure" && result.failure.reason === "already_answered",
          ),
        ).toHaveLength(1);
        yield* Queue.take(cards);
        expect(yield* Queue.size(cards)).toBe(0);
      }

      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT id FROM agent_feedback`).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a failed record leaves the card open, and a restarted store answers it", () =>
  Effect.gen(function* () {
    const { cards, shown, failRecords, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const card = yield* show(cards, "kept");
      yield* Ref.set(failRecords, true);
      expect((yield* Effect.flip(answer(card, "decline"))).reason).toBe("record_failed");
      expect((yield* Ref.get(shown)).get(card.turnItemId)?.feedbackStatus).toBe("pending");
      yield* Ref.set(failRecords, false);
      // A store started after the card was shown, as after a restart, answers from the card.
      yield* answer(card, "decline").pipe(Effect.provide(Store.layer));
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("declined");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a report stored before its card was settled settles the card on the next answer", () =>
  Effect.gen(function* () {
    const { cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stored = (reportId: string, sent: number) => sql`
        INSERT INTO agent_feedback ${sql.insert({
          ...report,
          id: reportId,
          thread_id: threadId,
          run_id: "run:1",
          created_at: "2026-01-01T00:00:00.000Z",
          user_requested: 1,
          trace: JSON.stringify(conversation),
          source: "mcp",
          sent,
        })}`;

      // Sent: either answer settles the card as sent, with the conversation it sent.
      const sentCard = yield* show(cards, "sent");
      yield* stored("sent", 1);
      yield* answer(sentCard, "decline");
      const settled = yield* Queue.take(cards);
      expect(settled).toMatchObject({
        feedbackStatus: "sent",
        preview: { ...report, trace: conversation },
      });
      expect(settled.conversationTrace).toBeUndefined();
      expect((yield* Effect.flip(answer(sentCard, "send"))).reason).toBe("already_answered");

      // Stored but not sent: the card closes unsent, with the outline only.
      const keptCard = yield* show(cards, "kept");
      yield* stored("kept", 0);
      yield* answer(keptCard, "send");
      const closed = yield* Queue.take(cards);
      expect(closed).toMatchObject({ feedbackStatus: "cancelled", preview: keptCard.preview });
      expect(closed.conversationTrace).toBeUndefined();
    }).pipe(Effect.provide(layer));
  }),
);
