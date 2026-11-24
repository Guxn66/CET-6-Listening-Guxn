import click
import logging
import math
from decimal import Decimal, InvalidOperation
import sys
from . import tui
from xmulogin import xmulogin
from .config import (
    load_config, save_config, is_config_complete, get_cookies_path,
    add_account, get_all_accounts, get_current_account, set_current_account,
    get_account_by_id, CONFIG_FILE, delete_account, perform_account_deletion,
    delete_saved_session, get_rollcall_settings, set_rollcall_settings, get_interval,
    get_disable_monitor_retry
)
from .logging_config import setup_logging
from .monitor import start_monitor, base_url, headers
from .attendance import list_rollcalls, send_qr, send_radar, answered
from .device_input import InputError, parse_qr_text, read_qr_image, select_qr_image, get_current_location
from .utils import load_session, save_session, verify_session
import requests

logger = logging.getLogger(__name__)

# ANSI Color codes
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    GRAY = '\033[90m'

@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx):
    log_file = setup_logging()
    ctx.ensure_object(dict)
    ctx.obj["log_file"] = log_file
    command_name = ctx.invoked_subcommand or "interactive"
    logger.info("CLI invoked: %s", command_name)
    if ctx.invoked_subcommand is None:
        interactive_menu(ctx)


def interactive_menu(ctx):
    if tui.console.is_terminal:
        tui.console.clear()
    aliases = {"1": "config", "2": "switch", "3": "start", "4": "refresh",
               "5": "qr", "6": "radar"}
    while True:
        data = load_config()
        tui.home(get_current_account(data), len(get_all_accounts(data)))
        try:
            action = tui.prompt("Command", type=click.Choice(
                ["1", "2", "3", "4", "5", "6", "config", "switch", "start", "refresh", "qr", "radar"],
                case_sensitive=False)).lower()
            command = cli.commands[aliases.get(action, action)]
            try:
                ctx.invoke(command)
            except SystemExit as exc:
                # Stopping monitoring ends the application; failed setup can be retried.
                logger.info("Interactive command %s exited: %s", command.name, exc.code)
                if command.name == "start" and exc.code in (None, 0):
                    return
            except click.Abort:
                if command.name == "start":
                    return
                tui.echo("Operation cancelled. Returning to commands.")
            except click.ClickException as exc:
                tui.echo(exc.format_message())
            except KeyboardInterrupt:
                if command.name == "start":
                    return
                tui.echo("Operation cancelled. Returning to commands.")
        except (click.Abort, KeyboardInterrupt):
            tui.echo("Goodbye!")
            return

def _submission_session():
    account = get_current_account(load_config())
    if not account:
        raise click.ClickException("Configure and select an account first.")
    session = requests.Session()
    if load_session(session, account["id"]) and verify_session(session):
        return session
    session.close()
    session = xmulogin(type=3, username=account["username"], password=account["password"])
    if not session:
        raise click.ClickException("Login failed; check your account configuration.")
    save_session(session, account["id"])
    return session


@cli.command(name="qr")
@click.option("--image", type=click.Path(exists=True, dir_okay=False), help="Current classroom QR image.")
@click.option("--text", help="Scanned QR text or URL.")
@click.option("--inspect", is_flag=True, help="Decode only; do not log in or submit.")
def qr_command(image, text, inspect):
    """Submit the current classroom QR code."""
    if image and text:
        raise click.UsageError("Choose either --image or --text.")
    try:
        if image is None and text is None:
            mode = tui.prompt("QR input: image or text", type=click.Choice(["image", "text"]), default="image")
            if mode == "text":
                text = tui.prompt("Scanned QR text or URL")
        data = parse_qr_text(text) if text is not None else read_qr_image(image or select_qr_image())
        if inspect:
            tui.echo(f"QR decoded: attendance task {data['rollcallId']}. No submission made.")
            return
        with _submission_session() as session:
            if not send_qr(session, data):
                raise click.ClickException("QR attendance was not confirmed. Check the current classroom code and official app.")
        tui.echo("QR attendance confirmed by the server.")
    except InputError as exc:
        raise click.ClickException(str(exc)) from exc
    except requests.RequestException as exc:
        raise click.ClickException("Network request failed; check the official app before retrying.") from exc


@cli.command(name="radar")
@click.option("--rollcall-id", type=click.IntRange(min=1), help="An active radar attendance task.")
@click.option("--locate-only", is_flag=True, help="Check device positioning without logging in or submitting.")
def radar_command(rollcall_id, locate_only):
    """Submit the current Windows device location."""
    try:
        if locate_only:
            position = get_current_location()
            tui.echo(f"Current device position available; reported accuracy {position['accuracy']:.0f} m.")
            return
        with _submission_session() as session:
            if rollcall_id is None:
                rows = [row for row in list_rollcalls(session)
                        if row.get("is_radar") and not row.get("is_expired") and not answered(row)]
                if not rows:
                    raise click.ClickException("No active unanswered radar attendance task.")
                for row in rows:
                    tui.echo(f"{row['rollcall_id']}: {row.get('course_title', '')}")
                rollcall_id = (rows[0]["rollcall_id"] if len(rows) == 1 else
                               tui.prompt("Attendance task ID", type=click.Choice(
                                   [str(row["rollcall_id"]) for row in rows])))
            if not send_radar(session, rollcall_id):
                raise click.ClickException("Radar attendance was not confirmed. Check Location permissions and the official app.")
        tui.echo("Radar attendance confirmed by the server.")
    except InputError as exc:
        raise click.ClickException(str(exc)) from exc
    except requests.RequestException as exc:
        raise click.ClickException("Network request failed; check the official app before retrying.") from exc


@cli.command()
def config():
    """配置账号和签到设置"""
    current_config = load_config()

    def show_accounts():
        accounts = get_all_accounts(current_config)
        tui.console.print(tui.accounts_panel(
            accounts, get_current_account(current_config), get_rollcall_settings))

    def add_new_account():
        tui.echo(f"{Colors.BOLD}Adding a new account...{Colors.ENDC}\n")
        username = tui.prompt(f"{Colors.BOLD}Username{Colors.ENDC}")
        password = tui.prompt(f"{Colors.BOLD}Password{Colors.ENDC}", hide_input=True)

        tui.echo(f"\n{Colors.OKCYAN}Validating credentials...{Colors.ENDC}")
        try:
            session = xmulogin(type=3, username=username, password=password)
            if not session:
                tui.echo(f"{Colors.FAIL}Login failed. Please check your credentials.{Colors.ENDC}")
                return

            logger.info("Credential validation succeeded for username=%s", username)
            tui.echo(f"{Colors.OKGREEN}Login successful!{Colors.ENDC}")

            tui.echo(f"{Colors.OKCYAN}Fetching user profile...{Colors.ENDC}")
            try:
                profile = session.get(f"{base_url}/api/profile", headers=headers).json()
                name = profile.get("name", "")
                tui.echo(f"{Colors.OKGREEN}Welcome, {name}!{Colors.ENDC}")
            except Exception:
                tui.echo(f"{Colors.WARNING}Could not fetch profile, using username as name{Colors.ENDC}")
                name = username

            try:
                account_id = add_account(current_config, username, password, name)
                save_config(current_config)
                tui.echo(f"{Colors.OKGREEN}Account added successfully! (ID: {account_id}){Colors.ENDC}")
                tui.echo(f"{Colors.GRAY}Configuration file: {CONFIG_FILE}{Colors.ENDC}\n")
            except RuntimeError as e:
                tui.echo(f"{Colors.FAIL}Failed to save configuration: {str(e)}{Colors.ENDC}")
                tui.echo(f"{Colors.WARNING}Tip: set XMU_ROLLCALL_CONFIG_DIR to choose a writable config directory.{Colors.ENDC}")
        except Exception as e:
            tui.echo(f"{Colors.FAIL}Error during login validation: {str(e)}{Colors.ENDC}")

    def delete_existing_account():
        accounts = get_all_accounts(current_config)
        if not accounts:
            tui.echo(f"{Colors.WARNING}No accounts to delete.{Colors.ENDC}\n")
            return

        show_accounts()
        valid_ids = [str(acc.get("id")) for acc in accounts]
        selected_id = tui.prompt(
            f"{Colors.BOLD}Enter account ID to delete{Colors.ENDC}",
            type=click.Choice(valid_ids, case_sensitive=False),
        )
        selected_id = int(selected_id)
        selected_account = get_account_by_id(current_config, selected_id)
        if not selected_account:
            tui.echo(f"{Colors.FAIL}Account not found.{Colors.ENDC}\n")
            return

        confirm = tui.prompt(
            f"{Colors.WARNING}Are you sure you want to delete account '{selected_account.get('name') or selected_account.get('username')}' (ID: {selected_id})?{Colors.ENDC}",
            type=click.Choice(['y', 'n'], case_sensitive=False),
            default='n',
        )
        if confirm.lower() != 'y':
            tui.echo(f"{Colors.GRAY}Deletion cancelled.{Colors.ENDC}\n")
            return

        success, cookies_to_delete, cookies_to_rename = delete_account(current_config, selected_id)
        if success:
            save_config(current_config)
            perform_account_deletion(cookies_to_delete, cookies_to_rename)
            tui.echo(f"{Colors.OKGREEN}Account deleted successfully!{Colors.ENDC}")
            if cookies_to_rename:
                tui.echo(f"{Colors.GRAY}Note: Account IDs have been re-assigned.{Colors.ENDC}")
            tui.echo()
        else:
            tui.echo(f"{Colors.FAIL}Failed to delete account.{Colors.ENDC}\n")

    def edit_account_settings():
        accounts = get_all_accounts(current_config)
        if not accounts:
            tui.echo(f"{Colors.WARNING}No accounts to configure.{Colors.ENDC}\n")
            return

        show_accounts()
        valid_ids = [str(acc.get("id")) for acc in accounts]
        selected_id = tui.prompt(
            f"{Colors.BOLD}Enter account ID to edit settings{Colors.ENDC}",
            type=click.Choice(valid_ids, case_sensitive=False),
        )
        selected_account = get_account_by_id(current_config, int(selected_id))
        if not selected_account:
            tui.echo(f"{Colors.FAIL}Account not found.{Colors.ENDC}\n")
            return

        settings = get_rollcall_settings(selected_account)
        current_wait = settings.get("wait_before_answer", False)
        current_wait_text = "false" if current_wait is False else str(current_wait)

        tui.echo()
        tui.echo(f"{Colors.BOLD}Rollcall settings for {selected_account.get('name') or selected_account.get('username')}:{Colors.ENDC}")
        tui.echo(f"  wait_before_answer: {Colors.OKCYAN}{current_wait_text}{Colors.ENDC}")
        tui.echo()
        tui.echo("Set wait_before_answer:")
        tui.echo("  false  - do not wait after getting the number code")
        tui.echo("  number - wait until that many classmates have signed")
        tui.echo("  20%    - wait until that percentage of students has signed")

        raw_value = tui.prompt(
            f"{Colors.BOLD}wait_before_answer{Colors.ENDC}",
            default=current_wait_text,
            show_default=True,
        ).strip().lower()

        if raw_value in ("false", "f", "no", "n", "0", "off", ""):
            wait_before_answer = False
        elif raw_value.endswith("%"):
            try:
                percentage = Decimal(raw_value[:-1])
                if not percentage.is_finite() or not 0 < percentage <= 100:
                    raise ValueError
            except (InvalidOperation, ValueError):
                tui.echo("Invalid percentage. Use a value greater than 0% and at most 100%.")
                return
            wait_before_answer = raw_value
        else:
            try:
                wait_before_answer = int(raw_value)
            except ValueError:
                tui.echo(f"{Colors.FAIL}Invalid value. Use false, a positive integer, or 20%.{Colors.ENDC}\n")
                return
            if wait_before_answer <= 0:
                wait_before_answer = False

        set_rollcall_settings(selected_account, {"wait_before_answer": wait_before_answer})
        save_config(current_config)
        saved = get_rollcall_settings(selected_account).get("wait_before_answer")
        saved_text = "false" if saved is False else str(saved)
        tui.echo(f"{Colors.OKGREEN}Settings saved. wait_before_answer = {saved_text}{Colors.ENDC}\n")

    def edit_interval():
        while True:
            value = tui.prompt("Polling interval (seconds)", type=float,
                               default=get_interval(current_config))
            if math.isfinite(value) and value > 0:
                break
            tui.echo("Invalid interval. Enter a finite number greater than zero.")
        current_config["interval"] = value
        save_config(current_config)
        tui.echo(f"Polling interval saved: {value:g}s (all accounts).")

    def edit_monitor_retry():
        current_config["disable_monitor_retry"] = not get_disable_monitor_retry(current_config)
        save_config(current_config)
        value = str(get_disable_monitor_retry(current_config)).lower()
        tui.echo(f"Disable monitor retries: {value} (saved for all accounts; applies on next start).")

    try:
        while True:
            tui.console.print(tui.frame(tui.Group(tui.sections(
                tui.accounts_panel(get_all_accounts(current_config),
                                   get_current_account(current_config), get_rollcall_settings),
                tui.panel(tui.menu_rows([
                    ("n", "Add new account"), ("d", "Delete account"),
                    ("s", "Edit rollcall settings"),
                    ("i", f"Polling interval: {get_interval(current_config):g}s (all accounts)"),
                    ("r", f"Disable monitor retries: {str(get_disable_monitor_retry(current_config)).lower()} (all accounts)")]),
                    "Actions", "blue")),
                tui.Text(f"Configuration file: {CONFIG_FILE.resolve()}", style="dim")),
                "Configuration", subtitle="Ctrl+C to return"))

            action = tui.prompt(
                f"{Colors.BOLD}Action{Colors.ENDC}",
                type=click.Choice(['n', 'd', 's', 'i', 'r'], case_sensitive=False),
            )

            if action.lower() == 'n':
                add_new_account()
            elif action.lower() == 'd':
                delete_existing_account()
            elif action.lower() == 's':
                edit_account_settings()
            elif action.lower() == 'i':
                edit_interval()
            elif action.lower() == 'r':
                edit_monitor_retry()
    except (click.Abort, KeyboardInterrupt):
        tui.echo("Configuration closed.")
        return

@cli.command()
def start():
    """启动签到监控"""
    # 加载配置
    logger.info("Start command selected")
    config_data = load_config()

    # 检查配置是否完整
    if not is_config_complete(config_data):
        tui.echo(f"{Colors.FAIL}✗ Configuration incomplete!{Colors.ENDC}")
        tui.echo(f"Please run: {Colors.BOLD}xmu-rollcall config{Colors.ENDC}")
        sys.exit(1)

    # 获取当前账号
    current_account = get_current_account(config_data)
    tui.echo(f"{Colors.OKCYAN}Using account: {current_account.get('name') or current_account.get('username')} (ID: {current_account.get('id')}){Colors.ENDC}")
    logger.info("Using account id=%s name=%s", current_account.get('id'), current_account.get('name') or current_account.get('username'))

    # 启动监控
    try:
        start_monitor(current_account)
    except KeyboardInterrupt:
        logger.info("Start command interrupted by user")
        tui.echo(f"\n{Colors.WARNING}Shutting down...{Colors.ENDC}")
        sys.exit(0)
    except Exception as e:
        logger.exception("Start command failed")
        tui.echo(f"\n{Colors.FAIL}Error: {str(e)}{Colors.ENDC}")
        sys.exit(1)

@cli.command()
def refresh():
    """刷新登录状态"""
    config_data = load_config()
    current_account = get_current_account(config_data)

    if not current_account:
        tui.echo(f"{Colors.FAIL}No account configured!{Colors.ENDC}")
        tui.echo(f"Please run: {Colors.BOLD}xmu-rollcall config{Colors.ENDC}")
        sys.exit(1)

    account_id = current_account.get("id")
    cookies_path = get_cookies_path(account_id)
    try:
        tui.echo(f"\n{Colors.WARNING}Deleting saved session for account {account_id} ({current_account.get('name')})...{Colors.ENDC}")
        delete_saved_session(account_id)
        # delete legacy cookies file if present
        import os
        if os.path.exists(cookies_path):
            os.remove(cookies_path)
            tui.echo(f"{Colors.OKGREEN}Saved session deleted successfully. Legacy cookies file removed too.{Colors.ENDC}")
        else:
            tui.echo(f"{Colors.OKGREEN}Saved session deleted successfully.{Colors.ENDC}")
        sys.exit(0)
    except Exception as e:
        tui.echo(f"{Colors.FAIL}Failed to delete saved session: {str(e)}{Colors.ENDC}")
        sys.exit(1)


@cli.command()
def switch():
    """切换当前使用的账号"""
    config_data = load_config()
    accounts = get_all_accounts(config_data)

    if not accounts:
        tui.echo(f"{Colors.FAIL}✗ No accounts configured!{Colors.ENDC}")
        tui.echo(f"Please run: {Colors.BOLD}xmu-rollcall config{Colors.ENDC}")
        sys.exit(1)

    tui.console.print(tui.frame(tui.accounts_panel(
        accounts, get_current_account(config_data), get_rollcall_settings), "Switch account"))

    # 让用户选择账号
    valid_ids = [str(acc.get("id")) for acc in accounts]
    selected_id = tui.prompt(
        f"{Colors.BOLD}Enter account ID to switch to{Colors.ENDC}",
        type=click.Choice(valid_ids, case_sensitive=False)
    )

    selected_id = int(selected_id)
    selected_account = get_account_by_id(config_data, selected_id)

    if selected_account:
        set_current_account(config_data, selected_id)
        save_config(config_data)
        tui.echo(f"\n{Colors.OKGREEN}✓ Switched to account: {selected_account.get('name') or selected_account.get('username')} (ID: {selected_id}){Colors.ENDC}")
        tui.echo(f"{Colors.GRAY}You can now run: {Colors.BOLD}xmu-rollcall start{Colors.ENDC}")
    else:
        tui.echo(f"{Colors.FAIL}✗ Account not found!{Colors.ENDC}")
        sys.exit(1)


if __name__ == '__main__':
    cli()

