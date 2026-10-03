            ownerKey,
            traceId,
            nativeTurnId,
            ...(nativeIdentity.threadId ? { nativeThreadId: nativeIdentity.threadId } : {}),
            conversationKey: contextExhaustion.conversationKey,
            exhaustedConversation: contextExhaustion.handle,
            capabilitySnapshot,
            signal: incoming.abortSignal,
            startRuntime: options => startRuntime(
              parsed,
              environment,
              capabilitySnapshot,
              traceId,
              turnCapabilities,
              providerTurn,
              options,
            ),
            onSessionCreated: created => {
              replaySession = created;
              if (!providerTurn.snapshot().physicalSettlementAttached) {
                providerCore.bindPhysicalSettlement(executionKey, created.physicalSettlement);
              }
            },
          });
          const coordinator = new ChatGptReplayCoordinator();
          try {
            await coordinator.replay({
              trigger: { code: CHATGPT_CONTEXT_EXHAUSTED_CODE },
              exhaustedConversation: contextExhaustion.handle,
              identity: replayIdentity,
              context: canonicalContext,
              boundary: replayBoundary,
            }, replayRuntime.transport);
          } catch (error) {
            const failedSession = replaySession ?? replayRuntime.getSession();
            if (!failedSession) {
              providerTurn.failBeforePhysicalSettlement();
            } else {
              if (providerTurn.snapshot().state !== "RETIRED") {
                providerTurn.markRecovery("FAILED");
              }
              failedSession.cancel(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
          }
          const replacementSession = replayRuntime.getSession();
          if (!replacementSession) throw new Error("ChatGPT replay completed without a replacement session");
          session = replacementSession;
          chatGptTurnSessions.clearContextExhaustion(executionKey);
        } else {
          try {
            session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
              executionKey,
              ownerKey,