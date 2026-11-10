"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALLOWED_IMAGE_TYPES,
  JUDGMENT_PRIORITY,
  PhotoItem,
  PhotoCategory,
  PHOTO_CATEGORY_LABELS,
  Judgment,
  DriveImageFile,
  getPhotoDisplayName,
} from "@/app/types";
import { judgePhoto, RateLimitExhaustedError } from "@/app/lib/judgePhoto";
import { calcCostUsd, sumUsage } from "@/app/lib/pricing";
import { PhotoCard } from "@/app/components/PhotoCard";
import { Lightbox } from "@/app/components/Lightbox";
import { ResultRow } from "@/app/components/ResultRow";
import { DriveImportPanel } from "@/app/components/DriveImportPanel";
import { JUDGMENT_STYLE } from "@/app/components/JudgmentBadges";
import { HistorySaveNotice } from "@/app/components/HistorySaveNotice";
import { PageHeader, PAGE_CONTAINER_CLASS } from "@/app/components/PageHeader";
import { APP_SUBTITLE } from "@/app/lib/appInfo";
import {
  HistorySaver,
  buildHistoryItem,
  classifyJudgeError,
  targetFromSelection,
  type SaverStatus,
} from "@/app/lib/history/client";
import type { HistoryItem } from "@/app/lib/history/types";

/**
 * 一度に扱える上限枚数。パソコン・Google Drive共通の正式仕様。
 * v2.18で200→300に変更(Google Drive側をメモリ節約方式に変更したため、
 * 300枚でも安全に扱えるようになった)。
 */
const MAX_PHOTOS = 300;

/**
 * 同時実行数(ワーカープールの並列数)。
 * 大きくしすぎるとOpenAI APIのレート制限(429)に引っかかりやすくなるため、
 * まずは安定性を優先して控えめな値にしている。安定していれば増やしてよい。
 */
const CONCURRENCY_LIMIT = 6;

/** ローカル選択した写真から、判定対象のPhotoItemを作る(実データを最初から保持) */
function createLocalPhotoItem(
  file: File,
  propertyName: string,
  category: PhotoCategory
): PhotoItem {
  return {
    id: crypto.randomUUID(),
    source: "local",
    file,
    previewUrl: URL.createObjectURL(file),
    propertyName,
    category,
    status: "waiting",
  };
}

/**
 * Google Driveで選んだ写真から、判定対象のPhotoItemを作る。
 * メモリ節約のため、この時点では実データ(file)を持たない軽量な状態。
 * previewUrlはサムネイル専用の軽量なAPI URLを使う(ダウンロード不要)。
 */
function createDrivePhotoItem(
  driveImage: DriveImageFile,
  propertyName: string,
  category: PhotoCategory
): PhotoItem {
  return {
    id: crypto.randomUUID(),
    source: "drive",
    file: undefined,
    previewUrl: driveImage.thumbnailUrl,
    propertyName,
    category,
    status: "waiting",
    driveFileId: driveImage.id,
    driveFileName: driveImage.name,
    driveMimeType: driveImage.mimeType,
  };
}

/** ミリ秒を「n分n秒」形式の文字列に変換する */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  return `${minutes}分${seconds}秒`;
}

export default function Home() {
  const [propertyName, setPropertyName] = useState("");
  const [defaultCategory, setDefaultCategory] = useState<PhotoCategory>("auto");
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  // --- ルール適用先(任意)。物件管理で登録した会社・物件を選ぶ。
  // 「物件名」(表示ラベル)とは目的が異なる、独立した選択項目。
  // 未選択(空文字)の場合はcompanyId/propertyIdをAPIへ送らず、
  // これまで通り標準基準のみで判定される。
  const [ruleCompanies, setRuleCompanies] = useState<{ companyId: string; companyLabel: string }[]>([]);
  const [ruleProperties, setRuleProperties] = useState<{ propertyId: string; propertyLabel: string }[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState("");

  useEffect(() => {
    fetch("/api/companies")
      .then((res) => res.json())
      .then((data) => setRuleCompanies(data.companies ?? []))
      .catch(() => setRuleCompanies([]));
  }, []);

  useEffect(() => {
    if (!selectedCompanyId) {
      setRuleProperties([]);
      return;
    }
    fetch(`/api/companies/${selectedCompanyId}/properties`)
      .then((res) => res.json())
      .then((data) => setRuleProperties(data.properties ?? []))
      .catch(() => setRuleProperties([]));
  }, [selectedCompanyId]);
  /** APIコスト欄の「詳細」開閉状態(現場でまず見るのは判定枚数・費用・時間の3項目のみ) */
  const [showCostDetail, setShowCostDetail] = useState(false);
  /** 判定中に「n / 合計枚数」を表示するための進捗情報(対象idの集合と合計数) */
  const [batchProgress, setBatchProgress] = useState<{
    targetIds: Set<string>;
    total: number;
  } | null>(null);
  const [lastBatchElapsedMs, setLastBatchElapsedMs] = useState<number | null>(null);
  const [lastBatchCount, setLastBatchCount] = useState(0);
  const [lastBatchRateLimitCount, setLastBatchRateLimitCount] = useState(0);
  const [lastBatchRetryCount, setLastBatchRetryCount] = useState(0);
  const [lastBatchRateLimitFailures, setLastBatchRateLimitFailures] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Google Drive連携用(既存のローカルアップロードとは独立した状態) ---
  const [uploadSource, setUploadSource] = useState<"local" | "drive">("local");
  const [addedDriveFileIds, setAddedDriveFileIds] = useState<Set<string>>(new Set());
  const [driveNotice, setDriveNotice] = useState<string | null>(null);

  // --- 判定履歴の保存(v0.4.0〜)。判定処理とは独立しており、保存の成否は判定結果に影響しない ---
  const [historyStatus, setHistoryStatus] = useState<SaverStatus>({ state: "idle" });
  const historySaverRef = useRef<HistorySaver | null>(null);
  if (historySaverRef.current === null) {
    historySaverRef.current = new HistorySaver({ onStatus: setHistoryStatus });
  }
  /** 写真ごとの判定世代番号(同じ写真を判定し直すたびに1ずつ増える。古い保存が新しい結果を上書きしないために使う) */
  const judgeGenRef = useRef(new Map<string, number>());

  // Google認証コールバック後のリダイレクト結果(?driveConnected=1 / ?driveError=...)を表示する
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("driveConnected");
    const error = params.get("driveError");

    if (connected) {
      setDriveNotice("Google Driveに接続しました。");
      setUploadSource("drive");
    } else if (error) {
      setDriveNotice(`Google Drive連携でエラーが発生しました: ${error}`);
      setUploadSource("drive");
    }

    if (connected || error) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const files = Array.from(fileList).filter((f) =>
        ALLOWED_IMAGE_TYPES.includes(f.type)
      );
      if (files.length === 0) return;

      setPhotos((prev) => {
        const room = MAX_PHOTOS - prev.length;
        const accepted = files.slice(0, Math.max(room, 0));
        const newItems = accepted.map((f) =>
          createLocalPhotoItem(f, propertyName, defaultCategory)
        );
        if (accepted.length < files.length) {
          setDriveNotice(
            `上限(${MAX_PHOTOS}枚)に達したため、${files.length - accepted.length}枚は追加されませんでした。`
          );
        }
        return [...prev, ...newItems];
      });
    },
    [propertyName, defaultCategory]
  );

  /** previewUrlがブラウザのオブジェクトURL(blob:)であれば解放する。二重解放しても問題ない */
  const revokePreviewUrl = (photo: PhotoItem) => {
    if (photo.previewUrl?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(photo.previewUrl);
      } catch {
        // すでに解放済みなどでエラーになっても無視してよい
      }
    }
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) revokePreviewUrl(target);
      return prev.filter((p) => p.id !== id);
    });
    setActivePhotoId((cur) => (cur === id ? null : cur));
  };

  /**
   * Google Driveで選んだ写真(まだ本体をダウンロードしていない、軽量な情報のみ)を、
   * ローカルアップロードと同じ`photos`配列へ追加する。
   * 実データのダウンロードは、判定の直前(runBatchJudge内)に1枚ずつ行う。
   */
  const addFilesFromDrive = useCallback(
    (items: DriveImageFile[]) => {
      setPhotos((prev) => {
        const room = MAX_PHOTOS - prev.length;
        const accepted = items.slice(0, Math.max(room, 0));
        const newItems = accepted.map((img) =>
          createDrivePhotoItem(img, propertyName, defaultCategory)
        );

        // 上限(MAX_PHOTOS)を超えて実際には追加されなかった写真は、
        // 「追加済み」として記録しない(次回選び直せるようにするため)。
        setAddedDriveFileIds((prevIds) => {
          const next = new Set(prevIds);
          accepted.forEach((img) => next.add(img.id));
          return next;
        });

        if (accepted.length < items.length) {
          const skipped = items.length - accepted.length;
          setDriveNotice(
            `上限(${MAX_PHOTOS}枚)に達したため、${skipped}枚は追加されませんでした。不要な写真を削除するか、判定を進めてから残りを追加してください。`
          );
        }

        return [...prev, ...newItems];
      });
    },
    [propertyName, defaultCategory]
  );

  const updatePhotoCategory = (id: string, category: PhotoCategory) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, category } : p)));
  };

  const clearAll = () => {
    setPhotos((prev) => {
      prev.forEach(revokePreviewUrl);
      return [];
    });
    setActivePhotoId(null);
    setAddedDriveFileIds(new Set());
    // 作業の区切り: 次の判定からは新しい履歴として保存する
    historySaverRef.current?.newSession();
    judgeGenRef.current.clear();
  };

  // コンポーネント自体が破棄される時(タブを閉じる等)にも、
  // 残っているオブジェクトURLを解放しておく(念のためのセーフティネット)。
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => {
    return () => {
      photosRef.current.forEach(revokePreviewUrl);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/session/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };

  /**
   * 未判定の写真を、同時実行数(CONCURRENCY_LIMIT)を上限とした
   * ワーカープール方式で判定する。
   * 全体を一括で並列送信するのではなく、常に最大N件だけが同時進行する状態を
   * 保つことで、OpenAI APIのレート制限(429)に配慮しつつ判定時間を短縮する。
   */
  const runBatchJudge = async () => {
    setIsBatchRunning(true);
    setLastBatchElapsedMs(null);
    setLastBatchRateLimitCount(0);
    setLastBatchRetryCount(0);
    setLastBatchRateLimitFailures(0);
    const startedAt = performance.now();

    const targets = photos.filter((p) => p.status === "waiting" || p.status === "error");
    setBatchProgress({ targetIds: new Set(targets.map((p) => p.id)), total: targets.length });

    // --- 履歴保存用の準備(判定の並列数・処理順・リトライには関与しない) ---
    // 判定に使うのと同じ選択値(このバッチ開始時点)を履歴の対象にする
    const historyTarget = targetFromSelection(selectedCompanyId, selectedPropertyId);
    const historyGens = new Map<string, number>();
    for (const t of targets) {
      const gen = (judgeGenRef.current.get(t.id) ?? 0) + 1;
      judgeGenRef.current.set(t.id, gen);
      historyGens.set(t.id, gen);
    }
    const historyItems: HistoryItem[] = [];
    /** 履歴用の記録。万一ここで例外が起きても判定処理には影響させない */
    const recordHistory = (build: () => HistoryItem) => {
      try {
        historyItems.push(build());
      } catch (e) {
        console.error("[history] 履歴用の記録に失敗しました:", e);
      }
    };
    let cursor = 0;
    let rateLimitHits = 0;
    let retryAttempts = 0;
    let rateLimitFailures = 0;

    const runWorker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor];
        cursor += 1;

        setPhotos((prev) =>
          prev.map((p) => (p.id === target.id ? { ...p, status: "judging" } : p))
        );
        // 履歴のエラー分類用: Drive取得と判定のどちらで失敗したか
        let historyStage: "drive" | "judge" = "judge";
        try {
          // Drive写真は、この時点(判定の直前)で初めて本体をダウンロードする。
          // これにより、同時にメモリ上へ実データを保持するのは
          // 「今まさに処理中のワーカーの数(=CONCURRENCY_LIMIT、最大6件)」だけになる。
          let fileToJudge: File;
          if (target.file) {
            fileToJudge = target.file;
          } else if (target.source === "drive" && target.driveFileId) {
            historyStage = "drive";
            const mimeType = target.driveMimeType ?? "image/jpeg";
            const res = await fetch(
              `/api/google-drive/file/${target.driveFileId}?mimeType=${encodeURIComponent(mimeType)}`
            );
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              throw new Error(
                data?.error ?? "Google Driveからの写真取得に失敗しました。"
              );
            }
            const blob = await res.blob();
            fileToJudge = new File(
              [blob],
              target.driveFileName ?? `${target.driveFileId}.jpg`,
              { type: mimeType }
            );
            historyStage = "judge";
          } else {
            throw new Error("判定対象の写真データが見つかりませんでした。");
          }

          const result = await judgePhoto(
            fileToJudge,
            target.propertyName || propertyName,
            target.category,
            {
              onRateLimited: () => {
                rateLimitHits += 1;
                setLastBatchRateLimitCount(rateLimitHits);
              },
              onRetry: (attempt, delayMs) => {
                retryAttempts += 1;
                setLastBatchRetryCount(retryAttempts);
                console.log(
                  `[rate-limit] ${getPhotoDisplayName(target)}: ${attempt}回目のリトライを${Math.round(
                    delayMs
                  )}ms後に実行します`
                );
              },
            },
            { companyId: selectedCompanyId, propertyId: selectedPropertyId }
          );
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === target.id
                ? {
                    ...p,
                    status: "done",
                    result,
                    errorMsg: undefined,
                    // Drive写真は判定が終わったら実データを手放し、メモリを解放する
                    // (サムネイル・ファイル名・判定結果は残るので表示上の影響はない)。
                    file: target.source === "drive" ? undefined : p.file,
                  }
                : p
            )
          );
          recordHistory(() =>
            buildHistoryItem(target, historyGens.get(target.id)!, target.propertyName || propertyName, { result }, new Date())
          );
        } catch (err) {
          if (err instanceof RateLimitExhaustedError) {
            rateLimitFailures += 1;
            setLastBatchRateLimitFailures(rateLimitFailures);
          }
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === target.id
                ? {
                    ...p,
                    status: "error",
                    errorMsg: err instanceof Error ? err.message : "判定に失敗しました。",
                    file: target.source === "drive" ? undefined : p.file,
                  }
                : p
            )
          );
          recordHistory(() =>
            buildHistoryItem(
              target,
              historyGens.get(target.id)!,
              target.propertyName || propertyName,
              { errorCode: classifyJudgeError(err, historyStage) },
              new Date()
            )
          );
        }
      }
    };

    const workerCount = Math.min(CONCURRENCY_LIMIT, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    setLastBatchElapsedMs(performance.now() - startedAt);
    setLastBatchCount(targets.length);
    setIsBatchRunning(false);

    // レート制限まわりのログをまとめてコンソールに出力(診断用)
    console.log(
      `[rate-limit] バッチ完了: 対象${targets.length}枚 / 429発生${rateLimitHits}回 / リトライ${retryAttempts}回 / 最終失敗${rateLimitFailures}枚`
    );

    // 判定がすべて終わった後で、履歴の保存を開始する(結果を待たない。失敗しても判定結果に影響しない)
    try {
      historySaverRef.current
        ?.enqueue(historyTarget, historyItems, {
          elapsedMs: Math.round(performance.now() - startedAt),
          rateLimitHits,
          retries: retryAttempts,
          rateLimitFailures,
        })
        .catch((e) => console.error("[history] 履歴の保存処理でエラーが発生しました:", e));
    } catch (e) {
      console.error("[history] 履歴の保存を開始できませんでした:", e);
    }
  };

  const hasWaiting = photos.some((p) => p.status === "waiting" || p.status === "error");

  /** 判定中に表示する「n / 合計枚数」の進捗(既存のphotos配列とステータスから計算するだけで、判定順序・6並列処理には影響しない) */
  const liveProgress = useMemo(() => {
    if (!batchProgress) return null;
    const doneCount = photos.filter(
      (p) =>
        batchProgress.targetIds.has(p.id) && (p.status === "done" || p.status === "error")
    ).length;
    return { done: doneCount, total: batchProgress.total };
  }, [photos, batchProgress]);

  const judgedPhotos = useMemo(
    () =>
      photos
        .filter((p) => p.status === "done" && p.result)
        .sort(
          (a, b) =>
            JUDGMENT_PRIORITY[a.result!.judgment] - JUDGMENT_PRIORITY[b.result!.judgment]
        ),
    [photos]
  );
  const activePhoto = photos.find((p) => p.id === activePhotoId) ?? null;

  const judgmentCounts = useMemo(() => {
    const counts: Record<Judgment, number> = {
      "◎ 良好": 0,
      "○ 基準内": 0,
      "◇ 確認推奨": 0,
      "△ 要調整": 0,
    };
    for (const p of judgedPhotos) {
      if (p.result) counts[p.result.judgment] += 1;
    }
    return counts;
  }, [judgedPhotos]);

  const costSummary = useMemo(() => {
    const usages = judgedPhotos
      .map((p) => p.result?.usage)
      .filter((u): u is NonNullable<typeof u> => Boolean(u));
    if (usages.length === 0) return null;

    const total = sumUsage(usages);
    const totalCostUsd = calcCostUsd(total);
    const avgCostUsd = totalCostUsd / usages.length;
    const cacheRatio =
      total.inputTokens > 0 ? ((total.cachedTokens ?? 0) / total.inputTokens) * 100 : 0;

    return {
      count: usages.length,
      avgInputTokens: Math.round(total.inputTokens / usages.length),
      avgOutputTokens: Math.round(total.outputTokens / usages.length),
      avgCachedTokens: Math.round((total.cachedTokens ?? 0) / usages.length),
      cacheRatio,
      totalCostUsd,
      avgCostUsd,
      estimatedCostFor200: avgCostUsd * 200,
    };
  }, [judgedPhotos]);

  return (
    <main className={PAGE_CONTAINER_CLASS}>
      <PageHeader
        title="清掃写真チェック"
        description={APP_SUBTITLE}
        right={
          <button
            onClick={handleLogout}
            className="text-sm text-inkfaint underline decoration-dotted hover:text-terracotta"
          >
            ログアウト
          </button>
        }
      />

      {/* 入力エリア */}
      <section className="rounded-2xl border border-hairline bg-surface p-6 shadow-card">
        <h2 className="font-display text-sm font-bold tracking-wide text-ink">
          01 / 物件名・写真をアップロード
        </h2>

        <label className="mt-4 block text-xs font-medium text-inkfaint">物件名</label>
        <input
          type="text"
          value={propertyName}
          onChange={(e) => setPropertyName(e.target.value)}
          placeholder="例: サンプル物件101"
          className="mt-1 w-full max-w-md rounded-lg border border-hairline bg-mist px-3 py-2.5 text-sm text-ink outline-none placeholder:text-inkfaint/70 focus:border-teal"
        />
        <p className="mt-1 text-xs text-inkfaint">
          ここで入力した物件名は、これから追加する写真に適用されます
        </p>

        <label className="mt-4 block text-xs font-medium text-inkfaint">
          写真カテゴリ(何を確認するための写真か)
        </label>
        <select
          value={defaultCategory}
          onChange={(e) => setDefaultCategory(e.target.value as PhotoCategory)}
          className="mt-1 w-full max-w-md rounded-lg border border-hairline bg-mist px-3 py-2.5 text-sm text-ink outline-none focus:border-teal"
        >
          {Object.entries(PHOTO_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-inkfaint">
          カテゴリを指定すると、その対象に絞って判定します(写真ごとに後から変更できます)。
        </p>


        {/*
          「ルール適用先」は、上の「物件名」(判定結果に付ける表示ラベル)とは
          目的が異なる。こちらは判定に使うルール(標準基準に加えて、会社別・
          物件別ルールを適用するか)を選ぶための項目。見た目でも区別できるよう、
          枠線で囲んで独立したブロックにしている。
        */}
        <div className="mt-5 rounded-xl border border-hairline bg-mist p-4">
          <p className="text-xs font-bold text-ink">物件固有ルール(任意)</p>
          <p className="mt-1 text-xs text-inkfaint">
            物件管理で登録したルールを判定に使う場合に選びます(上の「物件名」は表示用のラベルです)。
            <strong className="text-ink">未選択なら標準基準のみで判定します。</strong>
          </p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] text-inkfaint">会社</label>
              <select
                value={selectedCompanyId}
                onChange={(e) => {
                  setSelectedCompanyId(e.target.value);
                  setSelectedPropertyId("");
                }}
                className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-teal"
              >
                <option value="">標準モードのみ</option>
                {ruleCompanies.map((c) => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.companyLabel}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-inkfaint">物件(任意)</label>
              <select
                value={selectedPropertyId}
                onChange={(e) => setSelectedPropertyId(e.target.value)}
                disabled={!selectedCompanyId}
                className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-teal disabled:opacity-50"
              >
                <option value="">(物件を選択しない)</option>
                {ruleProperties.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.propertyLabel}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* アップロード元の切り替え(パソコン / Google Drive) */}
        <div className="mt-4 grid grid-cols-2 gap-2 border-b border-hairline">
          <button
            onClick={() => setUploadSource("local")}
            className={`truncate px-2 py-2.5 text-center text-sm font-medium transition-colors ${
              uploadSource === "local"
                ? "border-b-2 border-teal text-teal"
                : "border-b-2 border-transparent text-inkfaint hover:text-ink"
            }`}
          >
            パソコンから追加
          </button>
          <button
            onClick={() => setUploadSource("drive")}
            className={`truncate px-2 py-2.5 text-center text-sm font-medium transition-colors ${
              uploadSource === "drive"
                ? "border-b-2 border-teal text-teal"
                : "border-b-2 border-transparent text-inkfaint hover:text-ink"
            }`}
          >
            Google Driveから追加
          </button>
        </div>

        {driveNotice && (
          <p className="mt-2 text-xs text-inkfaint">
            {driveNotice}
            <button
              onClick={() => setDriveNotice(null)}
              className="ml-2 underline decoration-dotted hover:text-teal"
            >
              閉じる
            </button>
          </p>
        )}

        {uploadSource === "local" && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative mt-4 flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
              isDragging
                ? "border-teal bg-teal-soft"
                : "border-hairline bg-mist hover:border-teal/60"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="mb-2 text-inkfaint">
              <path
                d="M12 16V4M12 4L7 9M12 4L17 9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="text-sm font-medium text-ink">
              クリックまたはドラッグ&ドロップで写真を追加(複数選択可)
            </p>
            <p className="mt-1 text-xs text-inkfaint">
              JPEG / PNG / WebP・最大{MAX_PHOTOS}枚
            </p>
          </div>
        )}

        {uploadSource === "drive" && (
          <DriveImportPanel
            addedFileIds={addedDriveFileIds}
            onImport={addFilesFromDrive}
            disabled={isBatchRunning}
          />
        )}
      </section>

      {/* 写真一覧 */}
      {photos.length > 0 && (
        <section className="mt-6 rounded-2xl border border-hairline bg-surface p-6 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-sm font-bold tracking-wide text-ink">
              02 / 写真一覧({photos.length}枚)
            </h2>
            <div className="flex items-center gap-3">
              <button
                onClick={clearAll}
                disabled={isBatchRunning}
                className="text-xs text-inkfaint underline decoration-dotted hover:text-terracotta disabled:opacity-40"
              >
                すべて削除
              </button>
              <button
                onClick={runBatchJudge}
                disabled={!hasWaiting || isBatchRunning}
                className="rounded-lg bg-ink px-5 py-2.5 font-display text-sm font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30 enabled:hover:opacity-90"
              >
                {isBatchRunning ? "判定中…" : "判定開始"}
              </button>
            </div>
          </div>

          <HistorySaveNotice
            status={historyStatus}
            onRetry={() => {
              historySaverRef.current?.retry().catch((e) => console.error("[history] 再送に失敗しました:", e));
            }}
          />

          {/* 判定中の進捗表示(既存のphotos配列のステータスから計算するだけで、判定順序・6並列処理は変更しない) */}
          {isBatchRunning && liveProgress && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-inkfaint">
                <span>
                  判定中: {liveProgress.done} / {liveProgress.total} 枚完了
                </span>
                <span className="font-mono">
                  {liveProgress.total > 0
                    ? Math.round((liveProgress.done / liveProgress.total) * 100)
                    : 0}
                  %
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-mist">
                <div
                  className="h-full rounded-full bg-teal transition-all duration-300"
                  style={{
                    width: `${
                      liveProgress.total > 0
                        ? (liveProgress.done / liveProgress.total) * 100
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {photos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                onClick={() => setActivePhotoId(photo.id)}
                onRemove={() => removePhoto(photo.id)}
                onCategoryChange={(category) => updatePhotoCategory(photo.id, category)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 判定結果一覧(要調整・確認推奨が上位) */}
      {judgedPhotos.length > 0 && (
        <section className="mt-6 rounded-2xl border border-hairline bg-surface p-6 shadow-card">
          <h2 className="font-display text-sm font-bold tracking-wide text-ink">
            03 / 判定結果一覧
          </h2>
          <p className="mt-1 text-xs text-inkfaint">
            「△ 要調整」「◇ 確認推奨」を優先して上に表示しています
          </p>

          {/* 判定ランクごとの件数サマリー */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(judgmentCounts) as Judgment[]).map((judgment) => {
              const style = JUDGMENT_STYLE[judgment];
              return (
                <div
                  key={judgment}
                  className={`rounded-xl border p-3 ${style.ring} ${style.bg}`}
                >
                  <p className={`text-[11px] ${style.text}`}>{judgment}</p>
                  <p className={`mt-1 font-mono text-2xl font-bold ${style.text}`}>
                    {judgmentCounts[judgment]}
                    <span className="ml-1 text-xs font-normal">枚</span>
                  </p>
                </div>
              );
            })}
          </div>

          <div className="mt-4 space-y-2">
            {judgedPhotos.map((photo) => (
              <ResultRow
                key={photo.id}
                photo={photo}
                onClick={() => setActivePhotoId(photo.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* コスト集計(gpt-5.5のトークン使用量から算出) */}
      {costSummary && (
        <section className="mt-6 rounded-2xl border border-hairline bg-surface p-6 shadow-card">
          <h2 className="font-display text-sm font-bold tracking-wide text-ink">
            04 / API利用コスト(概算)
          </h2>
          <p className="mt-1 text-xs text-inkfaint">
            gpt-5.5 の公式単価(入力 $5.00 / 出力 $30.00 per 1M tokens)を基に算出。
            実際の請求額は為替・OpenAI側の料金改定により変動する場合があります。
          </p>

          {/* 現場でまず見る3項目: 判定枚数・合計費用・合計時間(常時表示) */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-hairline bg-mist p-3">
              <p className="text-[11px] text-inkfaint">判定済み枚数</p>
              <p className="mt-1 font-mono text-lg font-bold text-ink">
                {costSummary.count}枚
              </p>
            </div>
            <div className="rounded-xl border border-teal/30 bg-teal-soft p-3">
              <p className="text-[11px] text-teal">合計費用</p>
              <p className="mt-1 font-mono text-lg font-bold text-teal">
                ${costSummary.totalCostUsd.toFixed(4)}
              </p>
            </div>
            {lastBatchElapsedMs !== null && (
              <div className="rounded-xl border border-hairline bg-mist p-3">
                <p className="text-[11px] text-inkfaint">合計時間(今回のバッチ)</p>
                <p className="mt-1 font-mono text-lg font-bold text-ink">
                  {formatDuration(lastBatchElapsedMs)}
                </p>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowCostDetail((prev) => !prev)}
            className="mt-3 text-sm font-medium text-teal underline decoration-dotted"
          >
            {showCostDetail ? "詳細を閉じる" : "詳細を見る(トークン・キャッシュ率・429回数など)"}
          </button>

          {showCostDetail && (
            <div className="mt-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-hairline bg-mist p-3">
                  <p className="text-[11px] text-inkfaint">平均トークン数(入力/出力)</p>
                  <p className="mt-1 font-mono text-lg font-bold text-ink">
                    {costSummary.avgInputTokens.toLocaleString()} / {costSummary.avgOutputTokens.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-xl border border-hairline bg-mist p-3">
                  <p className="text-[11px] text-inkfaint">
                    プロンプトキャッシュ率(入力トークン中)
                  </p>
                  <p className="mt-1 font-mono text-lg font-bold text-ink">
                    {costSummary.cacheRatio.toFixed(1)}%
                  </p>
                  <p className="mt-0.5 text-[10px] text-inkfaint">
                    平均{costSummary.avgCachedTokens.toLocaleString()}トークン/枚がキャッシュ扱い
                  </p>
                </div>
                <div className="rounded-xl border border-hairline bg-mist p-3">
                  <p className="text-[11px] text-inkfaint">1枚あたり平均コスト</p>
                  <p className="mt-1 font-mono text-lg font-bold text-ink">
                    ${costSummary.avgCostUsd.toFixed(4)}
                  </p>
                </div>
                <div className="rounded-xl border border-teal/30 bg-teal-soft p-3">
                  <p className="text-[11px] text-teal">200枚あたり推定コスト</p>
                  <p className="mt-1 font-mono text-lg font-bold text-teal">
                    ${costSummary.estimatedCostFor200.toFixed(2)}
                  </p>
                </div>
              </div>
              {lastBatchElapsedMs !== null && (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-hairline bg-mist p-3">
                    <p className="text-[11px] text-inkfaint">
                      今回の判定所要時間(対象{lastBatchCount}枚・{CONCURRENCY_LIMIT}並列)
                    </p>
                    <p className="mt-1 font-mono text-lg font-bold text-ink">
                      {formatDuration(lastBatchElapsedMs)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-hairline bg-mist p-3">
                    <p className="text-[11px] text-inkfaint">1枚あたり平均時間</p>
                    <p className="mt-1 font-mono text-lg font-bold text-ink">
                      {(lastBatchElapsedMs / 1000 / Math.max(lastBatchCount, 1)).toFixed(1)}秒
                    </p>
                  </div>
                  <div
                    className={`rounded-xl border p-3 ${
                      lastBatchRateLimitCount > 0
                        ? "border-mustard/30 bg-mustard-soft"
                        : "border-hairline bg-mist"
                    }`}
                  >
                    <p
                      className={`text-[11px] ${
                        lastBatchRateLimitCount > 0 ? "text-mustard" : "text-inkfaint"
                      }`}
                    >
                      429(レート制限)発生回数
                    </p>
                    <p
                      className={`mt-1 font-mono text-lg font-bold ${
                        lastBatchRateLimitCount > 0 ? "text-mustard" : "text-ink"
                      }`}
                    >
                      {lastBatchRateLimitCount}回
                    </p>
                  </div>
                  <div
                    className={`rounded-xl border p-3 ${
                      lastBatchRetryCount > 0
                        ? "border-mustard/30 bg-mustard-soft"
                        : "border-hairline bg-mist"
                    }`}
                  >
                    <p
                      className={`text-[11px] ${
                        lastBatchRetryCount > 0 ? "text-mustard" : "text-inkfaint"
                      }`}
                    >
                      リトライ実行回数
                    </p>
                    <p
                      className={`mt-1 font-mono text-lg font-bold ${
                        lastBatchRetryCount > 0 ? "text-mustard" : "text-ink"
                      }`}
                    >
                      {lastBatchRetryCount}回
                    </p>
                  </div>
                  <div
                    className={`rounded-xl border p-3 ${
                      lastBatchRateLimitFailures > 0
                        ? "border-terracotta/30 bg-terracotta-soft"
                        : "border-hairline bg-mist"
                    }`}
                  >
                    <p
                      className={`text-[11px] ${
                        lastBatchRateLimitFailures > 0 ? "text-terracotta" : "text-inkfaint"
                      }`}
                    >
                      レート制限による最終失敗
                    </p>
                    <p
                      className={`mt-1 font-mono text-lg font-bold ${
                        lastBatchRateLimitFailures > 0 ? "text-terracotta" : "text-ink"
                      }`}
                    >
                      {lastBatchRateLimitFailures}枚
                    </p>
                  </div>
                </div>
              )}
              {lastBatchElapsedMs !== null && (
                <p className="mt-2 text-[11px] text-inkfaint">
                  詳細なリトライの履歴はブラウザの開発者ツール(コンソール)にも
                  `[rate-limit]` というログで出力されています。
                </p>
              )}
              <p className="mt-3 text-xs text-inkfaint">
                今回のセッションの合計: ${costSummary.totalCostUsd.toFixed(4)}
                (判定{costSummary.count}枚分)
              </p>
              {lastBatchElapsedMs !== null && (
                <p className="mt-1 text-xs text-inkfaint">
                  目安: 429が0〜数回程度なら並列数をさらに上げる余地あり。
                  頻発する場合は現在の並列数({CONCURRENCY_LIMIT})が上限に近い可能性があります。
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {activePhoto && (
        <Lightbox photo={activePhoto} onClose={() => setActivePhotoId(null)} />
      )}
    </main>
  );
}
