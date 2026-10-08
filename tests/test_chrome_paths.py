"""Where the dedicated Chrome is found and where its profile lives."""

from pathlib import Path

from jev_ultrafast import chrome


def test_a_per_user_chrome_install_is_found(monkeypatch, tmp_path):
    exe = tmp_path / "Google" / "Chrome" / "Application" / "chrome.exe"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(chrome, "_CANDIDATES", [])
    monkeypatch.setattr(chrome.shutil, "which", lambda _name: None)
    monkeypatch.delenv("BH_CHROME_PATH", raising=False)
    monkeypatch.delenv("CHROME_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert chrome.chrome_binary() == str(exe)


def test_the_profile_stays_next_to_a_source_checkout(tmp_path):
    checkout = tmp_path / "repo"
    (checkout / "core" / "jev_ultrafast").mkdir(parents=True)
    (checkout / "pyproject.toml").write_text("")
    profile = chrome.profile_dir(checkout / "core" / "jev_ultrafast", environ={}, platform="linux")
    assert profile == checkout / "core" / ".tmp-jev-chrome"


def test_an_installed_package_keeps_its_profile_out_of_site_packages(tmp_path):
    site = tmp_path / "venv" / "Lib" / "site-packages" / "jev_ultrafast"
    site.mkdir(parents=True)
    windows = chrome.profile_dir(site, environ={"LOCALAPPDATA": str(tmp_path / "local")}, platform="win32")
    assert windows == tmp_path / "local" / "jev-ultrafast" / "chrome-profile"
    linux = chrome.profile_dir(site, environ={"XDG_DATA_HOME": str(tmp_path / "xdg")}, platform="linux")
    assert linux == tmp_path / "xdg" / "jev-ultrafast" / "chrome-profile"
    for profile in (windows, linux):
        assert "site-packages" not in profile.parts


def test_the_default_profile_of_this_checkout_is_not_inside_site_packages():
    assert "site-packages" not in Path(chrome.PROFILE_DIR).parts
