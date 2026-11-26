using System.Windows;
using System.Windows.Controls;
using Microsoft.VisualStudio.PlatformUI;
using ShowMe.Core.Skills;

namespace ShowMe.VisualStudio.UI;

internal sealed class InstallSkillDialog : DialogWindow
{
    private readonly ComboBox _target = new() { ItemsSource = SkillInstaller.Targets, SelectedIndex = 0, MinWidth = 360 };
    private readonly ComboBox _scope = new() { ItemsSource = new[] { "Personal (all projects)", "Project (open solution or repository)" }, SelectedIndex = 0 };

    public SkillTarget Target => (SkillTarget)_target.SelectedItem;
    public bool Project => _scope.SelectedIndex == 1;

    public InstallSkillDialog()
    {
        Title = "ShowMe: Install Agent Skill";
        SizeToContent = SizeToContent.WidthAndHeight;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new TextBlock { Text = "Agent", Margin = new Thickness(0, 0, 0, 4) });
        panel.Children.Add(_target);
        panel.Children.Add(new TextBlock { Text = "Scope", Margin = new Thickness(0, 12, 0, 4) });
        panel.Children.Add(_scope);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        var install = new Button { Content = "Install", IsDefault = true, MinWidth = 75, Margin = new Thickness(0, 0, 8, 0) };
        install.Click += (_, _) => DialogResult = true;
        buttons.Children.Add(install);
        buttons.Children.Add(new Button { Content = "Cancel", IsCancel = true, MinWidth = 75 });
        panel.Children.Add(buttons);
        Content = panel;
    }
}
