using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Application.Services;
using PrintBit.Hardware.Devices.CoinAcceptor;
using PrintBit.Hardware.Devices.ESP32;
using PrintBit.Hardware.Devices.Hopper;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Services.SerialService;
using PrintBit.Infrastructure.Windows.Networking;
using PrintBit.Infrastructure.Windows.PowerMonitoring;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Infrastructure.Windows.Security;
using PrintBit.Infrastructure.Windows.Storage;
using PrintBit.Infrastructure.Windows.Time;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class ProgramRegistrationTests
{
    private static string GetSolutionRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null && !File.Exists(Path.Combine(current.FullName, "printbit-worker.slnx")))
        {
            current = current.Parent;
        }

        return current?.FullName ?? throw new DirectoryNotFoundException("Could not find solution root containing printbit-worker.slnx");
    }

    [Fact]
    public void AppSettings_ContainsPrinterRecoverySettingsAndWorkerCommandPipeName()
    {
        var appSettingsPath = Path.Combine(GetSolutionRoot(), "src", "PrintBit.HardwareService", "appsettings.json");
        Assert.True(File.Exists(appSettingsPath), $"Expected appsettings.json to exist at {appSettingsPath}");

        var config = new ConfigurationBuilder()
            .AddJsonFile(appSettingsPath, optional: false)
            .Build();

        var ipcSettings = new IpcSettings();
        config.GetSection("IpcSettings").Bind(ipcSettings);

        var recoverySection = config.GetSection("PrinterRecoverySettings");
        Assert.True(recoverySection.Exists(), "PrinterRecoverySettings section must exist in appsettings.json");

        var recoverySettings = new PrinterRecoverySettings();
        recoverySection.Bind(recoverySettings);

        Assert.Equal("printbit-worker-commands", ipcSettings.WorkerCommandPipeName);
        Assert.Equal("Spooler", recoverySettings.ServiceName);
        Assert.Equal(30, recoverySettings.SpoolerTransitionTimeoutSeconds);
        Assert.Equal(10, recoverySettings.HealthRecheckTimeoutSeconds);
        Assert.Equal(2, recoverySettings.HealthRecheckIntervalSeconds);
    }

    [Fact]
    public void AppSettingsDevelopment_ContainsPrinterRecoverySettingsAndWorkerCommandPipeName()
    {
        var devSettingsPath = Path.Combine(GetSolutionRoot(), "src", "PrintBit.HardwareService", "appsettings.Development.json");
        Assert.True(File.Exists(devSettingsPath), $"Expected appsettings.Development.json to exist at {devSettingsPath}");

        var config = new ConfigurationBuilder()
            .AddJsonFile(devSettingsPath, optional: false)
            .Build();

        var ipcSettings = new IpcSettings();
        config.GetSection("IpcSettings").Bind(ipcSettings);

        var recoverySection = config.GetSection("PrinterRecoverySettings");
        Assert.True(recoverySection.Exists(), "PrinterRecoverySettings section must exist in appsettings.Development.json");

        var recoverySettings = new PrinterRecoverySettings();
        recoverySection.Bind(recoverySettings);

        Assert.Equal("printbit-worker-commands", ipcSettings.WorkerCommandPipeName);
        Assert.Equal("Spooler", recoverySettings.ServiceName);
        Assert.Equal(30, recoverySettings.SpoolerTransitionTimeoutSeconds);
        Assert.Equal(10, recoverySettings.HealthRecheckTimeoutSeconds);
        Assert.Equal(2, recoverySettings.HealthRecheckIntervalSeconds);
    }

    [Fact]
    public void ProgramCs_RegistersAllPrinterRecoveryServices()
    {
        var programCsPath = Path.Combine(GetSolutionRoot(), "src", "PrintBit.HardwareService", "Program.cs");
        Assert.True(File.Exists(programCsPath), $"Expected Program.cs to exist at {programCsPath}");

        var content = File.ReadAllText(programCsPath);

        Assert.Contains("builder.Services.Configure<PrinterRecoverySettings>(builder.Configuration.GetSection(\"PrinterRecoverySettings\"));", content);
        Assert.Contains("builder.Services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();", content);
        Assert.Contains("builder.Services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();", content);
        Assert.Contains("builder.Services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();", content);
        Assert.Contains("builder.Services.AddHostedService<WorkerCommandPipeHostedService>();", content);
    }

    [Fact]
    public void ConfigurationBinding_BindsDefaultSettingsCorrectly()
    {
        var initialData = new Dictionary<string, string?>
        {
            ["IpcSettings:WorkerCommandPipeName"] = "printbit-worker-commands",
            ["PrinterRecoverySettings:ServiceName"] = "Spooler",
            ["PrinterRecoverySettings:SpoolerTransitionTimeoutSeconds"] = "30",
            ["PrinterRecoverySettings:HealthRecheckTimeoutSeconds"] = "10",
            ["PrinterRecoverySettings:HealthRecheckIntervalSeconds"] = "2"
        };

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(initialData)
            .Build();

        var ipcSettings = new IpcSettings();
        configuration.GetSection("IpcSettings").Bind(ipcSettings);

        var recoverySettings = new PrinterRecoverySettings();
        configuration.GetSection("PrinterRecoverySettings").Bind(recoverySettings);

        Assert.Equal("printbit-worker-commands", ipcSettings.WorkerCommandPipeName);
        Assert.Equal("Spooler", recoverySettings.ServiceName);
        Assert.Equal(30, recoverySettings.SpoolerTransitionTimeoutSeconds);
        Assert.Equal(10, recoverySettings.HealthRecheckTimeoutSeconds);
        Assert.Equal(2, recoverySettings.HealthRecheckIntervalSeconds);
    }

    [Fact]
    public void ServiceCollection_SimulatingProgramRegistration_ResolvesSingletonsAndHostedServices()
    {
        var services = new ServiceCollection();

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PrinterRecoverySettings:ServiceName"] = "Spooler",
                ["PrinterRecoverySettings:SpoolerTransitionTimeoutSeconds"] = "30",
                ["PrinterRecoverySettings:HealthRecheckTimeoutSeconds"] = "10",
                ["PrinterRecoverySettings:HealthRecheckIntervalSeconds"] = "2",
                ["IpcSettings:WorkerCommandPipeName"] = "printbit-worker-commands"
            })
            .Build();

        services.AddLogging();
        services.Configure<PrinterRecoverySettings>(configuration.GetSection("PrinterRecoverySettings"));
        services.Configure<IpcSettings>(configuration.GetSection("IpcSettings"));
        services.Configure<HardwareSettings>(configuration.GetSection("HardwareSettings"));

        var mockHealthMonitor = new Mock<IPrinterHealthMonitor>();
        services.AddSingleton(mockHealthMonitor.Object);

        services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();
        services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();
        services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();
        services.AddHostedService<WorkerCommandPipeHostedService>();

        using var provider = services.BuildServiceProvider();

        var coordinator = provider.GetService<IPrinterOperationCoordinator>();
        var spoolerController = provider.GetService<IPrintSpoolerController>();
        var recoveryService = provider.GetService<IPrinterRecoveryService>();
        var hostedServices = provider.GetServices<IHostedService>().ToList();
        var commandHostedService = hostedServices.OfType<WorkerCommandPipeHostedService>().FirstOrDefault();

        Assert.NotNull(coordinator);
        Assert.IsType<PrintOperationCoordinator>(coordinator);

        Assert.NotNull(spoolerController);
        Assert.IsType<ServiceControllerSpoolerController>(spoolerController);

        Assert.NotNull(recoveryService);
        Assert.IsType<PrinterRecoveryService>(recoveryService);

        Assert.NotNull(commandHostedService);
    }

    [Fact]
    public void ServiceCollection_ResolvesPrinterRecoveryServiceAndCoordinatorAsSingletons()
    {
        var services = new ServiceCollection();

        services.AddLogging();
        services.Configure<PrinterRecoverySettings>(_ => { });
        services.Configure<IpcSettings>(_ => { });
        services.Configure<HardwareSettings>(_ => { });

        var mockHealthMonitor = new Mock<IPrinterHealthMonitor>();
        services.AddSingleton(mockHealthMonitor.Object);

        services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();
        services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();
        services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();
        services.AddHostedService<WorkerCommandPipeHostedService>();

        using var provider = services.BuildServiceProvider();

        var recovery1 = provider.GetRequiredService<IPrinterRecoveryService>();
        var recovery2 = provider.GetRequiredService<IPrinterRecoveryService>();
        Assert.Same(recovery1, recovery2);

        var coord1 = provider.GetRequiredService<IPrinterOperationCoordinator>();
        var coord2 = provider.GetRequiredService<IPrinterOperationCoordinator>();
        Assert.Same(coord1, coord2);

        var ctrl1 = provider.GetRequiredService<IPrintSpoolerController>();
        var ctrl2 = provider.GetRequiredService<IPrintSpoolerController>();
        Assert.Same(ctrl1, ctrl2);
    }

    [Fact]
    public void ServiceCollection_WorkerCommandPipeHostedService_ResolvesRegisteredRecoveryServiceSingleton()
    {
        var services = new ServiceCollection();

        services.AddLogging();
        services.Configure<PrinterRecoverySettings>(_ => { });
        services.Configure<IpcSettings>(_ => { });
        services.Configure<HardwareSettings>(_ => { });

        var mockHealthMonitor = new Mock<IPrinterHealthMonitor>();
        services.AddSingleton(mockHealthMonitor.Object);

        services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();
        services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();
        services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();
        services.AddHostedService<WorkerCommandPipeHostedService>();

        using var provider = services.BuildServiceProvider();

        var recoverySingleton = provider.GetRequiredService<IPrinterRecoveryService>();
        var hostedService = provider.GetServices<IHostedService>()
            .OfType<WorkerCommandPipeHostedService>()
            .Single();

        var recoveryField = typeof(WorkerCommandPipeHostedService).GetField("_recoveryService", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(recoveryField);

        var injectedRecovery = recoveryField.GetValue(hostedService);
        Assert.Same(recoverySingleton, injectedRecovery);
    }

    [Fact]
    public void ServiceCollection_ResolvesHardwareOrchestratorSingleton()
    {
        var services = new ServiceCollection();

        services.AddLogging();
        services.Configure<HardwareSettings>(_ => { });
        services.Configure<IpcSettings>(_ => { });
        services.Configure<PowerSettings>(_ => { });

        services.AddSingleton<IPowerStatusProvider, NativePowerStatusProvider>();
        services.AddSingleton<IPowerSafetyGate, PowerSafetyGate>();
        services.AddSingleton<ISerialPortAdapter>(new Mock<ISerialPortAdapter>().Object);
        services.AddSingleton<ISerialConnection, SerialConnection>();
        services.AddSingleton<IEsp32Device, Esp32Device>();
        services.AddSingleton<CoinPulseDecoder>();
        services.AddSingleton<ICoinAcceptor, CoinAcceptorDevice>();
        services.AddSingleton<IHopper, HopperDevice>();
        services.AddSingleton<HardwareOrchestrator>();
        services.AddSingleton<IHardwareOrchestrator>(sp => sp.GetRequiredService<HardwareOrchestrator>());

        using var provider = services.BuildServiceProvider();

        var orchestrator1 = provider.GetRequiredService<IHardwareOrchestrator>();
        var orchestrator2 = provider.GetRequiredService<HardwareOrchestrator>();

        Assert.NotNull(orchestrator1);
        Assert.Same(orchestrator1, orchestrator2);
    }

    [Fact]
    public void ProgramCs_RegistersAllHardwareOrchestratorServices()
    {
        var programCsPath = Path.Combine(GetSolutionRoot(), "src", "PrintBit.HardwareService", "Program.cs");
        Assert.True(File.Exists(programCsPath), $"Expected Program.cs to exist at {programCsPath}");

        var content = File.ReadAllText(programCsPath);

        Assert.Contains("builder.Services.AddSingleton<ISerialConnection, SerialConnection>();", content);
        Assert.Contains("builder.Services.AddHostedService<SerialHostedService>();", content);
        Assert.Contains("builder.Services.AddSingleton<IEsp32Device, Esp32Device>();", content);
        Assert.Contains("builder.Services.AddSingleton<CoinPulseDecoder>();", content);
        Assert.Contains("builder.Services.AddSingleton<ICoinAcceptor, CoinAcceptorDevice>();", content);
        Assert.Contains("builder.Services.AddSingleton<IHopper, HopperDevice>();", content);
        Assert.Contains("builder.Services.AddSingleton<HardwareOrchestrator>();", content);
        Assert.Contains("builder.Services.AddSingleton<IHardwareOrchestrator>(sp => sp.GetRequiredService<HardwareOrchestrator>());", content);
    }

    [Fact]
    public void ProgramCs_RegistersAllPhase4PlatformServices()
    {
        var programCsPath = Path.Combine(GetSolutionRoot(), "src", "PrintBit.HardwareService", "Program.cs");
        Assert.True(File.Exists(programCsPath), $"Expected Program.cs to exist at {programCsPath}");

        var content = File.ReadAllText(programCsPath);

        Assert.Contains("builder.Services.AddSingleton<IAntivirusScanner, WindowsDefenderScanner>();", content);
        Assert.Contains("builder.Services.AddSingleton<UsbDriveMonitor>();", content);
        Assert.Contains("builder.Services.AddSingleton<IUsbStorageService>(sp => sp.GetRequiredService<UsbDriveMonitor>());", content);
        Assert.Contains("builder.Services.AddHostedService(sp => sp.GetRequiredService<UsbDriveMonitor>());", content);
        Assert.Contains("builder.Services.AddSingleton<ITrustedTimeProvider, WindowsTrustedTimeProvider>();", content);
        Assert.Contains("builder.Services.AddSingleton<IKioskNetworkPlatform, WindowsKioskNetworkPlatform>();", content);
        Assert.Contains("builder.Services.AddSingleton<WorkerPlatformCommandHandler>();", content);
    }

    [Fact]
    public void ServiceCollection_ResolvesPhase4PlatformServicesAndSameUsbMonitorInstance()
    {
        var services = new ServiceCollection();

        services.AddLogging();
        services.AddSingleton<IAntivirusScanner, WindowsDefenderScanner>();
        services.AddSingleton<UsbDriveMonitor>();
        services.AddSingleton<IUsbStorageService>(sp => sp.GetRequiredService<UsbDriveMonitor>());
        services.AddHostedService(sp => sp.GetRequiredService<UsbDriveMonitor>());
        services.AddSingleton<ITrustedTimeProvider, WindowsTrustedTimeProvider>();
        services.AddSingleton<IKioskNetworkPlatform, WindowsKioskNetworkPlatform>();
        services.AddSingleton<IWorkerEventPipeClient>(new Mock<IWorkerEventPipeClient>().Object);
        services.AddSingleton<WorkerPlatformCommandHandler>();

        using var provider = services.BuildServiceProvider();

        Assert.NotNull(provider.GetRequiredService<IAntivirusScanner>());
        Assert.NotNull(provider.GetRequiredService<ITrustedTimeProvider>());
        Assert.NotNull(provider.GetRequiredService<IKioskNetworkPlatform>());
        Assert.NotNull(provider.GetRequiredService<WorkerPlatformCommandHandler>());

        var usbService = provider.GetRequiredService<IUsbStorageService>();
        var usbMonitor = provider.GetRequiredService<UsbDriveMonitor>();
        var hostedMonitors = provider.GetServices<IHostedService>().OfType<UsbDriveMonitor>().ToList();

        Assert.NotNull(usbService);
        Assert.Same(usbMonitor, usbService);
        Assert.Single(hostedMonitors);
        Assert.Same(usbMonitor, hostedMonitors[0]);
    }
}


