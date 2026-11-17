import type { StorageAdapter } from '../storage/interface.js';

export interface RunJob {
  tenantId: string;
  runId: string;
}

export type JobProcessor = (job: RunJob) => Promise<void>;

export interface QueueAdapter {
  readonly driver: 'local' | 'nats';
  start(processor: JobProcessor): Promise<void>;
  enqueue(job: RunJob): Promise<void>;
  stop(): Promise<void>;
  getStats(): { pending: number; active: number; concurrency: number };
}

/**
 * Zero-config durable local worker pool.
 * Persisted runs in StorageAdapter are automatically recovered on boot so jobs survive restarts.
 */
export class LocalDurableQueue implements QueueAdapter {
  public readonly driver = 'local' as const;
  private readonly storage: StorageAdapter;
  private readonly concurrency: number;
  private readonly queue: RunJob[] = [];
  private readonly seenKeys = new Set<string>();
  private active = 0;
  private processor: JobProcessor | null = null;
  private stopped = false;

  constructor(storage: StorageAdapter, concurrency = 16) {
    this.storage = storage;
    this.concurrency = Math.max(1, concurrency);
  }

  async start(processor: JobProcessor): Promise<void> {
    this.processor = processor;
    this.stopped = false;
    // Crash recovery: re-enqueue any pending/in-flight runs persisted before restart
    const pending = await this.storage.listPendingRunsAcrossTenants();
    for (const job of pending) {
      await this.enqueue(job);
    }
  }

  async enqueue(job: RunJob): Promise<void> {
    if (this.stopped) return;
    const key = `${job.tenantId}::${job.runId}`;
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.stopped || !this.processor) return;
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const key = `${job.tenantId}::${job.runId}`;
      this.active++;
      void this.processor(job)
        .catch((err) => {
          console.error(`[LocalDurableQueue] Unhandled error processing ${key}:`, err);
        })
        .finally(() => {
          this.active--;
          this.seenKeys.delete(key);
          this.pump();
        });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const deadline = Date.now() + 5000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  getStats(): { pending: number; active: number; concurrency: number } {
    return {
      pending: this.queue.length,
      active: this.active,
      concurrency: this.concurrency,
    };
  }
}

/**
 * Self-hosted distributed NATS JetStream Queue Adapter.
 * Activated via `QUEUE_DRIVER=nats` and `NATS_URL=nats://...` for horizontally scaled worker fleets.
 */
export class NatsJetStreamQueue implements QueueAdapter {
  public readonly driver = 'nats' as const;
  private readonly natsUrl: string;
  private readonly concurrency: number;
  private nc: any = null;
  private js: any = null;
  private active = 0;
  private stopped = false;

  constructor(natsUrl: string, concurrency = 16) {
    this.natsUrl = natsUrl;
    this.concurrency = concurrency;
  }

  async start(processor: JobProcessor): Promise<void> {
    const nats = await import('nats');
    const sc = nats.StringCodec();
    this.nc = await nats.connect({ servers: this.natsUrl });
    const jsm = await this.nc.jetstreamManager();

    try {
      await jsm.streams.info('SAGAFLOW_RUNS');
    } catch {
      await jsm.streams.add({
        name: 'SAGAFLOW_RUNS',
        subjects: ['sagaflow.runs.>'],
        retention: nats.RetentionPolicy.Workqueue,
        storage: nats.StorageType.File,
      });
    }

    this.js = this.nc.jetstream();
    const consumerName = 'sagaflow-workers';
    try {
      await jsm.consumers.info('SAGAFLOW_RUNS', consumerName);
    } catch {
      await jsm.consumers.add('SAGAFLOW_RUNS', {
        durable_name: consumerName,
        ack_policy: nats.AckPolicy.Explicit,
        max_ack_pending: this.concurrency * 2,
      });
    }

    const consumer = await this.js.consumers.get('SAGAFLOW_RUNS', consumerName);
    this.stopped = false;

    void (async () => {
      const messages = await consumer.consume({ max_messages: this.concurrency });
      for await (const msg of messages) {
        if (this.stopped) break;
        this.active++;
        void (async () => {
          try {
            const job = JSON.parse(sc.decode(msg.data)) as RunJob;
            await processor(job);
            msg.ack();
          } catch (err) {
            console.error('[NatsJetStreamQueue] Job failed:', err);
            msg.nak(1000);
          } finally {
            this.active--;
          }
        })();
      }
    })();
  }

  async enqueue(job: RunJob): Promise<void> {
    if (!this.js) throw new Error('NatsJetStreamQueue not started');
    const nats = await import('nats');
    const sc = nats.StringCodec();
    await this.js.publish(`sagaflow.runs.${job.tenantId}`, sc.encode(JSON.stringify(job)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }

  getStats(): { pending: number; active: number; concurrency: number } {
    return { pending: 0, active: this.active, concurrency: this.concurrency };
  }
}
