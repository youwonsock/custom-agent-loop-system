import type { DirectoryDialogModel } from "./viewModels";

export default function DirectoryDialog({
  controller,
}: {
  controller: DirectoryDialogModel;
}) {
  const {
    setTarget,
    setNotice,
    directory,
    setDirectory,
    directoryBusy,
    browse,
  } = controller;

  return (
    <>
      {directory && (
        <div className="modal-backdrop">
          <section
            className="directory-modal"
            role="dialog"
            aria-label="프로젝트 폴더 선택"
          >
            <div>
              <h2>프로젝트 폴더 선택</h2>
              <button
                aria-label="폴더 선택 닫기"
                onClick={() => setDirectory(null)}
              >
                ×
              </button>
            </div>
            <code>{directory.path}</code>
            <button
              className="directory-entry"
              disabled={directoryBusy || directory.parent === directory.path}
              onClick={() => void browse(directory.parent)}
            >
              ↥ 상위 폴더
            </button>
            <div className="directory-list">
              {directory.directories.map((name) => (
                <button
                  key={name}
                  className="directory-entry"
                  onClick={() =>
                    void browse(
                      `${directory.path.replace(/[\\/]$/, "")}/${name}`,
                    )
                  }
                >
                  ▣ {name} <span>›</span>
                </button>
              ))}
              {!directory.directories.length && (
                <p className="field-hint">하위 폴더가 없습니다.</p>
              )}
            </div>
            <button
              className="button primary full"
              onClick={() => {
                setTarget(directory.path);
                setDirectory(null);
                setNotice(
                  "대상 프로젝트를 선택했습니다. 이 프로젝트에서 모델을 다시 조회하세요.",
                );
              }}
            >
              이 폴더 사용
            </button>
          </section>
        </div>
      )}
    </>
  );
}
