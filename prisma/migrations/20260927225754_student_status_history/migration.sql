-- CreateEnum
CREATE TYPE "StatusChangeSource" AS ENUM ('EVENT', 'BASELINE');

-- CreateTable
CREATE TABLE "StudentStatusChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "StudentStatus" NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "sequence" INTEGER NOT NULL,
    "source" "StatusChangeSource" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentStatusChange_studentId_effectiveOn_sequence_idx" ON "StudentStatusChange"("studentId", "effectiveOn", "sequence");

-- CreateIndex
CREATE INDEX "StudentStatusChange_organizationId_idx" ON "StudentStatusChange"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentStatusChange_studentId_sequence_key" ON "StudentStatusChange"("studentId", "sequence");

-- AddForeignKey
ALTER TABLE "StudentStatusChange" ADD CONSTRAINT "StudentStatusChange_organizationId_studentId_fkey" FOREIGN KEY ("organizationId", "studentId") REFERENCES "Student"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentStatusChange" ADD CONSTRAINT "StudentStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentStatusChange" ADD CONSTRAINT "StudentStatusChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
