import { z } from 'zod';
import { NotFoundError } from '@/server/errors';
import {
  createTRPCRouter,
  mutationProcedure,
  protectedProcedure,
  toTrpcError,
} from '@/server/trpc/trpc';
import { EmailListInputSchema } from './domain/query';
import * as repository from './repository/email-repository';

/**
 * Email queries.
 *
 * Procedures stay thin: validate, delegate, shape. Every repository call passes
 * `ctx.user.id`, so the scoping is visible at each call site rather than assumed.
 */
export const emailsRouter = createTRPCRouter({
  list: protectedProcedure
    .input(EmailListInputSchema)
    .query(async ({ ctx, input }) => repository.listEmails(ctx.user.id, input)),

  byId: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const email = await repository.getEmailForUser(ctx.user.id, input.id);
      if (!email) throw toTrpcError(new NotFoundError('Email'));
      return email;
    }),

  thread: protectedProcedure
    .input(z.object({ gmailThreadId: z.string().min(1) }))
    .query(async ({ ctx, input }) =>
      repository.getThreadForUser(ctx.user.id, input.gmailThreadId),
    ),

  markRead: mutationProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await repository.markRead(ctx.user.id, input.id);
      if (!updated) throw toTrpcError(new NotFoundError('Email'));
      return { ok: true };
    }),
});
