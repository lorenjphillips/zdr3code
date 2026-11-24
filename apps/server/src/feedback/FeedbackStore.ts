// Answers the cards of requested agent feedback reports. A card is answered from what it
// recorded, so it stays answerable after its turn ends and after a restart.
import {
  type AgentFeedbackAnswerInput,
  type AgentFeedbackPreview,
  type AgentFeedbackRequestStatus,
  AgentFeedbackRequestError,
  AgentFeedbackTrace,
  CommandId,
  type NodeId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const CARD_PREFIX = "turn-item:feedback-request:";

/** A requested report waiting for the user's answer, shown in its run. */
interface FeedbackCard {
  readonly reportId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly preview: AgentFeedbackPreview;
}

export class FeedbackStore extends Context.Service<
  FeedbackStore,
  {
    /** Either answer closes the card, once. Send sends nothing and fails with `feedback_off`. */
    readonly answer: (
      input: AgentFeedbackAnswerInput,
    ) => Effect.Effect<void, AgentFeedbackRequestError>;
  }
>()("t3/feedback/FeedbackStore") {}

const decodeTrace = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.fromJsonString(AgentFeedbackTrace)),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  // Serializes answers, each from its claim through settling its card.
  const answering = yield* Semaphore.make(1);

  const record = (card: FeedbackCard, feedbackStatus: AgentFeedbackRequestStatus) =>
    threads.dispatch({
      type: "feedback_request.record",
      commandId: CommandId.make(`feedback-request:${card.reportId}:${feedbackStatus}`),
      threadId: card.threadId,
      runId: card.runId,
      nodeId: card.nodeId,
      turnItemId: TurnItemId.make(`${CARD_PREFIX}${card.reportId}`),
      preview: card.preview,
      feedbackStatus,
    });

  const answer = Effect.fn("FeedbackStore.answer")(function* (input: AgentFeedbackAnswerInput) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "agent_feedback.answer": input.answer,
    });
    const fail = (reason: AgentFeedbackRequestError["reason"]) =>
      Effect.fail(new AgentFeedbackRequestError({ reason }));
    const recordFailed = (cause: unknown) =>
      new AgentFeedbackRequestError({ reason: "record_failed", cause });
    const { turnItems } = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["feedback_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((cause) => new AgentFeedbackRequestError({ reason: "load_failed", cause })),
      );
    const item = turnItems.find((candidate) => candidate.id === input.turnItemId);
    // A fork lists the cards it inherited; only the thread that asked answers one.
    if (
      item?.type !== "feedback_request" ||
      item.threadId !== input.threadId ||
      item.runId === null ||
      item.nodeId === null ||
      !item.id.startsWith(CARD_PREFIX)
    ) {
      return yield* fail("not_found");
    }
    if (item.feedbackStatus !== "pending") return yield* fail("already_answered");
    const card = {
      reportId: item.id.slice(CARD_PREFIX.length),
      threadId: input.threadId,
      runId: item.runId,
      nodeId: item.nodeId,
    };
    // Settles the card with the trace it sent. Without one, it keeps only the outline.
    const settle = (status: AgentFeedbackRequestStatus, trace = item.preview.trace) =>
      record({ ...card, preview: { ...item.preview, trace } }, status).pipe(
        Effect.mapError(recordFailed),
      );

    // One answer at a time, from the claim through settling the card, so no other answer can
    // settle it differently in between.
    yield* answering
      .withPermit(
        Effect.gen(function* () {
          const [waiting] = yield* sql<{ readonly waiting: number }>`
            SELECT 1 AS waiting FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id = ${item.id} AND status = 'waiting'`;
          if (waiting === undefined) return yield* fail("already_answered");
          // Stored before its card was settled, by a crash or a failed record: settle it now. A
          // report not known to be refused reads as sent.
          const [stored] = yield* sql<{ readonly sent: number; readonly trace: string | null }>`
            SELECT sent, trace FROM agent_feedback WHERE id = ${card.reportId}`;
          if (stored !== undefined) {
            if (stored.sent !== 1) return yield* settle("cancelled");
            return yield* settle("sent", yield* decodeTrace(stored.trace));
          }
          if (input.answer === "decline") return yield* settle("declined");
          yield* settle("cancelled");
          return yield* fail("feedback_off");
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (error) => Effect.fail(recordFailed(error)),
          SchemaError: (error) => Effect.fail(recordFailed(error)),
        }),
      );
  });

  return FeedbackStore.of({ answer });
});

export const layer = Layer.effect(FeedbackStore, make);
