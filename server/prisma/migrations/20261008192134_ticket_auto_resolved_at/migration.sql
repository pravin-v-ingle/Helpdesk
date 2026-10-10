-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "autoResolvedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Ticket_autoResolvedAt_lastMessageAt_idx" ON "Ticket"("autoResolvedAt", "lastMessageAt");
