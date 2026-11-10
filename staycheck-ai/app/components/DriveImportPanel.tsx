"use client";

import { useEffect, useState } from "react";
import { DriveImageFile } from "@/app/types";

interface Props {
  /** 既に追加済みのDriveファイルID(重複追加防止のため、選択済み扱いで表示する) */
  addedFileIds: Set<string>;
  /**
   * 「選択した写真を追加」が押された時に呼ばれる。
   * v2.18〜: メモリ節約のため、この時点では画像本体をダウンロードしない。
   * 選んだ写真の軽量な情報(ID・ファイル名・種類・取得用URL)だけを渡し、
   * 実際のダウンロードは判定の直前(page.tsx側)で1枚ずつ行う。
   */
  onImport: (items: DriveImageFile[]) => void;
  /** 取り込み処理中かどうか(親側のバッチ判定中などと衝突しないように) */
  disabled?: boolean;
}

interface DriveFolder {
  id: string;
  name: string;
}

type ConnectionState = "checking" | "disconnected" | "connected";
type FolderState = "idle" | "loading" | "loaded" | "error";
type ListState = "idle" | "loading" | "loaded" | "error";

export function DriveImportPanel({ addedFileIds, onImport, disabled }: Props) {
  const [connection, setConnection] = useState<ConnectionState>("checking");

  // --- フォルダ選択(物件フォルダを1つ選んでから画像一覧を取得する) ---
  const [folderState, setFolderState] = useState<FolderState>("idle");
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [rootFolderId, setRootFolderId] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);

  const [listState, setListState] = useState<ListState>("idle");
  const [images, setImages] = useState<DriveImageFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 初回表示時に接続状態を確認する
  useEffect(() => {
    fetch("/api/google-drive/status")
      .then((res) => res.json())
      .then((data) => {
        setConnection(data.connected ? "connected" : "disconnected");
      })
      .catch(() => setConnection("disconnected"));
  }, []);

  const fetchFolders = async () => {
    setFolderState("loading");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/google-drive/folders");
      const data = await res.json();

      if (!res.ok) {
        if (data.code === "auth") setConnection("disconnected");
        setErrorMsg(data.error ?? "フォルダ一覧の取得に失敗しました。");
        setFolderState("error");
        return;
      }

      setFolders(data.folders ?? []);
      setRootFolderId(data.rootFolderId ?? null);
      setFolderState("loaded");
    } catch {
      setErrorMsg("Google Driveとの通信中にエラーが発生しました。ネットワーク状況を確認してください。");
      setFolderState("error");
    }
  };

  useEffect(() => {
    if (connection === "connected" && folderState === "idle") {
      fetchFolders();
    }
  }, [connection, folderState]);

  const fetchImages = async (folderId: string) => {
    setListState("loading");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/google-drive/files?folderId=${encodeURIComponent(folderId)}`);
      const data = await res.json();

      if (!res.ok) {
        if (data.code === "auth") {
          setConnection("disconnected");
        }
        setErrorMsg(data.error ?? "画像一覧の取得に失敗しました。");
        setListState("error");
        return;
      }

      setImages(data.images ?? []);
      setListState("loaded");
    } catch {
      setErrorMsg("Google Driveとの通信中にエラーが発生しました。ネットワーク状況を確認してください。");
      setListState("error");
    }
  };

  const chooseFolder = (folder: DriveFolder) => {
    setSelectedFolder(folder);
    setSelectedIds(new Set());
    setListState("idle");
    fetchImages(folder.id);
  };

  const backToFolderList = () => {
    setSelectedFolder(null);
    setImages([]);
    setSelectedIds(new Set());
    setListState("idle");
    setErrorMsg(null);
  };

  const toggleSelect = (id: string) => {
    if (addedFileIds.has(id)) return; // 追加済みは選択不可
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectableImages = images.filter((img) => !addedFileIds.has(img.id));

  const selectAll = () => {
    setSelectedIds(new Set(selectableImages.map((img) => img.id)));
  };
  const deselectAll = () => setSelectedIds(new Set());

  const handleImport = () => {
    const targets = images.filter((img) => selectedIds.has(img.id));
    if (targets.length === 0) return;

    // v2.18〜: ここでは画像本体をダウンロードしない。
    // 軽量なメタデータだけを親(page.tsx)に渡し、実際のダウンロードは
    // 判定の直前に1枚ずつ行う(同時に保持する画像データを最小限にするため)。
    onImport(targets);
    setSelectedIds(new Set());
  };

  if (connection === "checking") {
    return (
      <div className="mt-4 flex min-h-[140px] items-center justify-center rounded-xl border-2 border-dashed border-hairline bg-mist">
        <p className="text-sm text-inkfaint">Google Driveの接続状態を確認しています…</p>
      </div>
    );
  }

  if (connection === "disconnected") {
    return (
      <div className="mt-4 flex min-h-[140px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-hairline bg-mist p-4 text-center">
        <p className="text-sm text-ink">
          Google Driveに接続すると、指定フォルダの写真を直接読み込めます。
        </p>
        <a
          href="/api/google-drive/auth"
          className="rounded-lg bg-ink px-5 py-2.5 font-display text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          Google Driveに接続
        </a>
        {errorMsg && <p className="text-xs text-terracotta">{errorMsg}</p>}
      </div>
    );
  }

  // --- ステップ1: 物件フォルダを選ぶ ---
  if (!selectedFolder) {
    return (
      <div className="mt-4 rounded-xl border border-hairline bg-mist p-4">
        <p className="text-xs text-inkfaint">
          読み込む物件フォルダを選んでください(選んだフォルダの中の画像だけが対象になります)。
        </p>

        {folderState === "loading" && (
          <div className="flex min-h-[100px] items-center justify-center">
            <p className="text-sm text-inkfaint">フォルダ一覧を取得中です…</p>
          </div>
        )}

        {folderState === "error" && (
          <div className="flex min-h-[100px] flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-terracotta">{errorMsg}</p>
            <button
              onClick={fetchFolders}
              className="text-xs text-inkfaint underline decoration-dotted hover:text-teal"
            >
              もう一度読み込む
            </button>
          </div>
        )}

        {folderState === "loaded" && (
          <>
            {folders.length === 0 ? (
              <div className="mt-3 rounded-lg border border-hairline bg-surface p-3 text-center text-sm text-inkfaint">
                サブフォルダが見つかりませんでした。指定フォルダ直下の画像を読み込みます。
                <button
                  onClick={() => rootFolderId && chooseFolder({ id: rootFolderId, name: "(指定フォルダ直下)" })}
                  disabled={!rootFolderId}
                  className="mt-2 block w-full rounded-lg bg-ink px-4 py-2 font-display text-sm font-bold text-white transition-opacity hover:opacity-90"
                >
                  このフォルダの画像を読み込む
                </button>
              </div>
            ) : (
              <div className="mt-3 max-h-[280px] space-y-1.5 overflow-y-auto">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => chooseFolder(folder)}
                    className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-left text-sm text-ink transition-colors hover:border-teal"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-inkfaint">
                      <path
                        d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                    </svg>
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // --- ステップ2: 選んだフォルダの画像一覧 ---
  return (
    <div className="mt-4 rounded-xl border border-hairline bg-mist p-4">
      <button
        onClick={backToFolderList}
        disabled={disabled}
        className="mb-2 text-xs text-inkfaint underline decoration-dotted hover:text-teal disabled:opacity-40"
      >
        ← フォルダ選択に戻る
      </button>
      <p className="text-xs font-medium text-ink">
        選択中のフォルダ: <span className="text-teal">{selectedFolder.name}</span>
      </p>

      {listState === "loading" && (
        <div className="flex min-h-[100px] items-center justify-center">
          <p className="text-sm text-inkfaint">Google Driveの画像一覧を取得中です…</p>
        </div>
      )}

      {listState === "error" && (
        <div className="flex min-h-[100px] flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-terracotta">{errorMsg}</p>
          <button
            onClick={() => fetchImages(selectedFolder.id)}
            className="text-xs text-inkfaint underline decoration-dotted hover:text-teal"
          >
            もう一度読み込む
          </button>
        </div>
      )}

      {listState === "loaded" && (
        <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-inkfaint">
              {images.length}枚中 {selectableImages.length}枚が未追加(
              {selectedIds.size}枚選択中)
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={selectAll}
                disabled={disabled}
                className="text-xs text-inkfaint underline decoration-dotted hover:text-teal disabled:opacity-40"
              >
                全選択
              </button>
              <button
                onClick={deselectAll}
                disabled={disabled}
                className="text-xs text-inkfaint underline decoration-dotted hover:text-terracotta disabled:opacity-40"
              >
                全解除
              </button>
              <button
                onClick={() => fetchImages(selectedFolder.id)}
                disabled={disabled}
                className="text-xs text-inkfaint underline decoration-dotted hover:text-teal disabled:opacity-40"
              >
                再読み込み
              </button>
            </div>
          </div>

          {images.length === 0 ? (
            <p className="mt-4 text-center text-sm text-inkfaint">
              このフォルダに画像が見つかりませんでした(JPEG/PNG/WebPのみ対象)。
            </p>
          ) : (
            <div className="mt-3 grid max-h-[360px] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
              {images.map((img) => {
                const added = addedFileIds.has(img.id);
                const selected = selectedIds.has(img.id);
                return (
                  <button
                    key={img.id}
                    onClick={() => toggleSelect(img.id)}
                    disabled={added || disabled}
                    className={`relative overflow-hidden rounded-lg border-2 text-left transition-colors ${
                      added
                        ? "cursor-not-allowed border-hairline opacity-40"
                        : selected
                          ? "border-teal"
                          : "border-transparent hover:border-teal/50"
                    }`}
                  >
                    <img
                      src={img.thumbnailUrl}
                      alt={img.name}
                      loading="lazy"
                      className="h-20 w-full object-cover"
                    />
                    {added && (
                      <span className="absolute inset-x-0 bottom-0 bg-ink/70 px-1 py-0.5 text-center text-[9px] text-white">
                        追加済み
                      </span>
                    )}
                    {!added && selected && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-teal text-[10px] text-white">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {errorMsg && <p className="mt-2 text-xs text-terracotta">{errorMsg}</p>}

          <button
            onClick={handleImport}
            disabled={selectedIds.size === 0 || disabled}
            className="mt-4 w-full rounded-lg bg-ink px-4 py-2.5 font-display text-sm font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30 enabled:hover:opacity-90"
          >
            {`選択した写真を追加(${selectedIds.size}枚)`}
          </button>
          <p className="mt-2 text-[11px] text-inkfaint">
            ここでは写真の中身をまだダウンロードしません。実際のデータ取得は
            「判定開始」を押した後、1枚ずつ判定の直前に行われます(端末への負荷を抑えるため)。
          </p>
        </>
      )}
    </div>
  );
}
